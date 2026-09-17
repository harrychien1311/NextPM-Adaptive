import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { documentsApi, inputApi, projectApi } from '../../api/endpoints';
import { Ring } from '../../components/Ring';
import { useToast } from '../../components/Toast';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import { DocumentPreview } from './DocumentPreview';
import { UploadPreview } from './UploadPreview';
import { CustomerReadinessPanel } from './CustomerReadinessPanel';
import type { LibraryEntry } from '../../api/types';
import type { WorkspaceView } from '../WorkspacePage';

const TASK_STATE: Record<string, string> = {
  DONE: 'done-state',
  REVIEW: 'review-state',
  BLOCKED: 'blocked-state',
  TODO: 'review-state',
};

const DOMAIN_LABEL: Record<string, string> = {
  GOVERNANCE: 'Governance',
  SCOPE: 'Scope',
  SCHEDULE: 'Schedule',
  FINANCE: 'Finance',
  STAKEHOLDERS: 'Stakeholders',
  RESOURCES: 'Resources',
  RISK: 'Risk',
  PROJECT_PLAN: 'Project Plan',
  KICKOFF: 'Kickoff',
};

/**
 * How the Ready-to-Start percentage was built, in the PM's words. The server decides which applies
 * (`workspace.basis`); this only names it, so the ring and the explanation cannot disagree.
 */
const READINESS_BASIS: Record<string, { label: string; help: string }> = {
  CUSTOMER_AND_OUTPUTS: {
    label: 'Customer standardization + approved planning outputs',
    help: 'Weighted 60% on how far this project meets the standards its customer set, and 40% on the share of planning outputs the PM has approved.',
  },
  CUSTOMER: {
    label: 'Customer standardization',
    help: 'How far this project meets the standards its customer set. Approved planning outputs join the score once the document pack exists.',
  },
  INPUT_AND_OUTPUTS: {
    label: 'Verified inputs + approved planning outputs',
    help: 'This customer has no checklist in the library, so the score falls back to verified inputs and approved planning outputs, evenly weighted. Upload their checklist to score against their own standards instead.',
  },
  INPUT: {
    label: 'Verified inputs',
    help: 'Nothing has been generated yet, so this is verified input coverage alone.',
  },
};

const WIDGET_LABELS: [string, string][] = [
  ['readiness', 'Start readiness'],
  ['approach', 'Management approach'],
  ['outputs', 'Document progress'],
  ['tasks', 'Planning tasks'],
  ['decisions', 'PM decisions'],
  ['domains', 'Project information coverage'],
  ['customer', 'Project readiness by customer standardization'],
  ['library', 'Planning documents'],
  ['activity', 'Agent activity'],
];

export function DashboardView({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** The document list starts folded away — it is the longest thing on the dashboard by far. */
  const [libraryOpen, setLibraryOpen] = useState(false);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: () => projectApi.dashboard(projectId),
  });

  const saveLayout = useMutation({
    mutationFn: (widgets: Record<string, boolean>) => projectApi.saveLayout(projectId, widgets),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      setDrawerOpen(false);
      notify({ title: 'Dashboard layout saved', detail: 'Your widget selection is now this workspace default.' });
    },
  });

  const [widgets, setWidgets] = useState<Record<string, boolean> | null>(null);
  const activeWidgets = widgets ?? data?.widgets ?? {};

  /** The Planning documents row the PM clicked; decides which of the two previews opens. */
  const [preview, setPreview] = useState<LibraryEntry | null>(null);

  /**
   * Resolving a PM action is the one write on an otherwise read-only screen, so it is the only
   * control here that a viewer is locked out of. Navigation and preview stay open to them: those
   * only read, and locking them would stop a view-only account doing the one thing it exists for.
   */
  const { canWrite, guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);
  /** The action whose answer box is open, and what the PM has typed into it. */
  const [resolving, setResolving] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');

  const resolveAction = useMutation({
    mutationFn: ({ actionId, value }: { actionId: string; value: string }) =>
      inputApi.resolveAction(projectId, actionId, value),
    onSuccess: () => {
      // The server writes the answer into the input profile and recomputes domain readiness, so
      // three panels move at once and all three are on screen.
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      setResolving(null);
      setAnswer('');
      notify({ title: 'Action resolved', detail: 'It is off the list and recorded in the audit trail.' });
    },
    onError: (error) => notify({ title: 'Could not resolve the action', detail: (error as Error).message }),
  });

  // Generated documents are fetched on demand — the dashboard payload carries only the listing.
  const previewDoc = useQuery({
    queryKey: ['document', projectId, preview?.id],
    queryFn: () => documentsApi.detail(projectId, preview!.id),
    enabled: preview?.kind === 'GENERATED',
  });

  // Escape closes whichever preview is open, and the page behind must not scroll under it.
  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setPreview(null);
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [preview]);

  if (isLoading || !data) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading planning control center…
        </div>
      </section>
    );
  }

  const show = (key: string) => activeWidgets[key] !== false;

  return (
    <section className="view active">
      <div className="page-head">
        <div>
          <p>{data.workspace.type} PROJECT WORKSPACE</p>
          <h1>One view. Every setup decision.</h1>
          <span>
            {data.workspace.approach
              ? `Your ${titleCase(data.workspace.approach.approach)} approach is confirmed. ${data.startReadiness.note}.`
              : 'No management approach confirmed yet. Verify the project input, then review the recommended approach.'}
          </span>
        </div>
        <div className="dashboard-actions">
          <button
            className="secondary icon-only"
            onClick={() => refetch()}
            title={isRefetching ? 'Refreshing…' : 'Refresh status'}
            aria-label="Refresh status"
          >
            ↻
          </button>
          <button
            className="primary icon-only"
            onClick={() => setDrawerOpen(true)}
            title="Customize dashboard"
            aria-label="Customize dashboard"
          >
            ⚙
          </button>
        </div>
      </div>

      <div className="metric-grid v2-metrics">
        {show('readiness') && (
          <article className="metric widget">
            <div className="metric-label">
              <span>READY TO START</span>
              <button className="help" title={READINESS_BASIS[data.workspace.basis].help}>
                ?
              </button>
            </div>
            <div className="score-row">
              <Ring value={data.startReadiness.score} className="readiness-ring v2-ready" />
              <div>
                <strong className={data.startReadiness.verdict.tone === 'green' ? '' : 'amber'}>
                  {data.startReadiness.verdict.label}
                </strong>
                {/* A percentage with no stated basis is a number nobody can argue with or act on. */}
                <small className="readiness-basis">{READINESS_BASIS[data.workspace.basis].label}</small>
                <p>{data.startReadiness.note}</p>
                <button className="text-button" onClick={() => onNavigate('studio')}>
                  Review blockers →
                </button>
              </div>
            </div>
          </article>
        )}

        {show('approach') && (
          <article className="metric widget">
            <div className="metric-label">
              <span>MANAGEMENT APPROACH</span>
              {data.workspace.approach && <span className="confirmed-pill">✓ PM confirmed</span>}
            </div>
            <div className="approach-summary">
              <span className="hybrid-mark">
                {(data.workspace.approach?.approach ?? data.workspace.recommendation?.approach ?? '?')[0]}
              </span>
              <div>
                <strong>
                  {data.workspace.approach
                    ? titleCase(data.workspace.approach.approach)
                    : data.workspace.recommendation
                      ? `${titleCase(data.workspace.recommendation.approach)} (recommended)`
                      : 'Not selected'}
                </strong>
                <p>{data.workspace.approach?.rigor ?? 'Awaiting PM decision'}</p>
                {data.workspace.recommendation && <small>Rule match {data.workspace.recommendation.confidence}%</small>}
              </div>
            </div>
            <button className="text-button" onClick={() => onNavigate('approach')}>
              View rationale →
            </button>
          </article>
        )}

        {show('outputs') && (
          <article className="metric widget">
            <div className="metric-label">
              {/* "Planning outputs" named the same thing three widgets away from "Planning
                  documents" (the file list) — this one is the pack's progress through generation
                  and approval, so it says that. */}
              <span>DOCUMENT PROGRESS</span>
              <span className="delta">
                {data.outputs.generated} of {data.outputs.total} generated
              </span>
            </div>
            <div className="task-chart">
              <Ring value={data.outputs.percent} className="task-ring v2-output" />
              <ul>
                <li>
                  <i className="green" />
                  PM approved <b>{data.outputs.approved}</b>
                </li>
                <li>
                  <i className="blue" />
                  PM review <b>{data.outputs.inReview}</b>
                </li>
                <li>
                  <i className="gray" />
                  Not generated <b>{data.outputs.notGenerated}</b>
                </li>
              </ul>
            </div>
          </article>
        )}
      </div>

      <div className="dashboard-grid">
        {show('tasks') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>Planning tasks</h2>
                <p>Status of the project setup workflow</p>
              </div>
              <span className="count-pill">
                {data.tasks.complete}/{data.tasks.total} complete
              </span>
            </div>
            <div className="task-board">
              {data.tasks.items.map((task) => (
                <div key={task.id}>
                  <span className={`task-state ${TASK_STATE[task.state]}`}>{task.state}</span>
                  <strong>{task.title}</strong>
                  <small>{task.detail}</small>
                </div>
              ))}
            </div>
          </article>
        )}

        {show('decisions') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>PM action center</h2>
                <p>AI prepares; the PM decides</p>
              </div>
              <button className="ghost" onClick={() => onNavigate('studio')}>
                View all
              </button>
            </div>
            {data.actions.length === 0 && (
              <div className="program-empty">
                No open PM decisions right now. The list is built from the planning gaps the last
                analysis found — run <em>Analyze planning needs</em> on Project Input to fill it.
              </div>
            )}
            {data.actions.map((action) => (
              <div
                key={action.id}
                className={`decision-item ${action.priority === 'REQUIRED' ? 'critical' : action.priority === 'CONDITIONAL' ? 'warning' : 'info'}`}
              >
                <span>{action.priority === 'REQUIRED' ? '!' : action.priority === 'CONDITIONAL' ? '◇' : 'i'}</span>
                <div>
                  <small>
                    {action.priority} · {DOMAIN_LABEL[action.domain]?.toUpperCase()}
                  </small>
                  <strong>{action.title}</strong>
                  <p>{action.description}</p>
                  {resolving === action.id && (
                    <form
                      className="action-answer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (answer.trim()) resolveAction.mutate({ actionId: action.id, value: answer.trim() });
                      }}
                    >
                      {/*
                        The PM says how it was closed rather than just ticking it off: the answer is
                        stored as `resolvedValue`, written into a matching input field where the
                        title names one, and logged. "Done" with no record is how a planning gap
                        comes back a month later with nobody able to say what was decided.
                      */}
                      <input
                        autoFocus
                        value={answer}
                        onChange={(event) => setAnswer(event.target.value)}
                        placeholder="How is this covered? e.g. “Escalation path agreed with the customer on 12 Sep”"
                      />
                      {action.suggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          className="answer-chip"
                          onClick={() => setAnswer(`Covered by ${suggestion}`)}
                        >
                          Covered by {suggestion}
                        </button>
                      ))}
                      <div className="answer-actions">
                        <button type="submit" className="primary small" disabled={!answer.trim() || resolveAction.isPending}>
                          {resolveAction.isPending ? 'Saving…' : 'Save'}
                        </button>
                        <button type="button" className="ghost" onClick={() => setResolving(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
                <div className="decision-buttons">
                  {/* Where the work actually happens — Input for a hole in the profile, the Studio
                      for a missing document. The server picked which from the catalog. */}
                  <button onClick={() => onNavigate(action.targetView)}>Open</button>
                  <button
                    className={lockClass.trim()}
                    {...lockedProps}
                    onClick={guard(() => {
                      setResolving(resolving === action.id ? null : action.id);
                      setAnswer('');
                    })}
                  >
                    {canWrite && resolving === action.id ? 'Close' : 'Resolve'}
                  </button>
                </div>
              </div>
            ))}
          </article>
        )}
      </div>

      <div className="dashboard-grid lower">
        {show('domains') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                {/*
                  This measures INPUT FIELDS, not documents — `recomputeDomainReadiness` scores the
                  share of each domain's inputs that are filled and PM-verified. The old name
                  ("Planning readiness by domain") read as if it were about generated documents,
                  which is a different widget entirely.
                */}
                <h2>Project information coverage</h2>
                <p>Share of each domain’s input fields that are filled and PM-verified</p>
              </div>
              <span className="legend">
                <i />
                Target 80%
              </span>
            </div>
            <div className="domain-bars">
              {data.domains.map((row) => (
                <div key={row.domain}>
                  <span>{DOMAIN_LABEL[row.domain]}</span>
                  <div>
                    <i
                      className={row.score >= 75 ? '' : row.score >= 55 ? 'warn' : 'danger'}
                      style={{ width: `${row.score}%` }}
                    />
                    <b className="target" />
                  </div>
                  <strong>{row.score}%</strong>
                </div>
              ))}
            </div>
          </article>
        )}

        {/* The readiness the customer would actually ask about, next to the one we ask ourselves. */}
        {show('customer') && (
          <article className="widget wide">
            <CustomerReadinessPanel projectId={projectId} />
          </article>
        )}

        {show('library') && (
          <article className="panel widget wide">
            {/*
              The list runs to every upload plus every generated document, which pushed the rest of
              the dashboard off the screen. It is collapsed until asked for; the count stays visible
              so nothing about the project is hidden, only its detail.
            */}
            <div className="panel-head">
              <div>
                <h2>Planning documents</h2>
                <p>Everything attached to this project — what you uploaded and what the AI wrote</p>
              </div>
              <span className="copilot-badge">{data.library.length} total</span>
              <button
                className="disclosure"
                aria-expanded={libraryOpen}
                title={libraryOpen ? 'Hide the document list' : 'Show the document list'}
                onClick={() => setLibraryOpen((open) => !open)}
              >
                {libraryOpen ? '▴' : '▾'}
              </button>
            </div>
            {!libraryOpen ? null : data.library.length === 0 ? (
              <div className="program-empty">
                Nothing yet. Upload reference files on Project Input, or generate a document in the Planning Studio.
              </div>
            ) : (
              <div className="doc-library">
                {data.library.map((item) => (
                  <button
                    className="library-row"
                    key={`${item.kind}-${item.id}`}
                    onClick={() => setPreview(item)}
                    title="View document"
                  >
                    <span className={`library-icon ${item.kind === 'GENERATED' ? 'ai' : 'pm'}`}>
                      {item.kind === 'GENERATED' ? '✦' : '▤'}
                    </span>
                    <span className="library-name">
                      <b>{item.name}</b>
                      <small>
                        {item.category}
                        {item.sizeBytes ? ` · ${Math.max(1, Math.round(item.sizeBytes / 1024))} KB` : ''}
                        {item.at ? ` · ${new Date(item.at).toLocaleDateString()}` : ''}
                      </small>
                    </span>
                    <span className={`origin-tag ${item.origin === 'AI_GENERATED' ? 'ai' : 'pm'}`}>
                      {item.origin === 'AI_GENERATED' ? 'AI generated' : 'PM input'}
                    </span>
                    <span className="library-view">View document →</span>
                  </button>
                ))}
              </div>
            )}
          </article>
        )}

        {show('activity') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>Agent &amp; approval activity</h2>
                <p>Traceable rule, generation and PM actions</p>
              </div>
              <span className="copilot-badge">✦ {data.activity.length} recent</span>
            </div>
            <ul className="activity">
              {data.activity.map((event) => (
                <li key={event.id}>
                  <i>{event.actorType === 'AGENT' ? '✦' : event.type.includes('APPROVED') ? '✓' : '?'}</i>
                  <div>
                    <strong>{event.title}</strong>
                    <span>{event.detail ?? (event.actor ? `By ${event.actor.name}` : 'System')}</span>
                  </div>
                  <time>{relativeTime(event.createdAt)}</time>
                </li>
              ))}
            </ul>
          </article>
        )}
      </div>

      <div className={`dashboard-drawer${drawerOpen ? ' open' : ''}`}>
        <div className="drawer-head">
          <div>
            <strong>Customize dashboard</strong>
            <span>Choose what appears in your one-view summary</span>
          </div>
          <button onClick={() => setDrawerOpen(false)}>×</button>
        </div>
        <div className="dashboard-options">
          {WIDGET_LABELS.map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={activeWidgets[key] !== false}
                onChange={(event) => setWidgets({ ...activeWidgets, [key]: event.target.checked })}
              />{' '}
              {label}
            </label>
          ))}
        </div>
        <button className="primary full" onClick={() => saveLayout.mutate(activeWidgets)} disabled={saveLayout.isPending}>
          {saveLayout.isPending ? 'Saving…' : 'Save dashboard layout'}
        </button>
      </div>

      {preview?.kind === 'UPLOAD' && (
        <UploadPreview
          projectId={projectId}
          fileId={preview.id}
          fileName={preview.name}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'GENERATED' && previewDoc.data && (
        <DocumentPreview
          document={previewDoc.data}
          projectId={projectId}
          projectName={data.workspace.name}
          onClose={() => setPreview(null)}
          onDownload={() =>
            documentsApi.download(projectId, preview.id, preview.name, previewDoc.data.exportFormat)
          }
        />
      )}
    </section>
  );
}

const titleCase = (value: string) => value[0] + value.slice(1).toLowerCase();

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
