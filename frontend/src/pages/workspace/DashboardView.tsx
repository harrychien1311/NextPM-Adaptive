import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { documentsApi, inputApi, projectApi } from '../../api/endpoints';

import { Ring } from '../../components/Ring';
import { useToast } from '../../components/Toast';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import { DocumentPreview } from './DocumentPreview';
import { UploadPreview } from './UploadPreview';
import { CustomerReadinessPanel } from './CustomerReadinessPanel';
import { PmActionList } from './PmActionList';
import { StandardDetailModal } from './StandardDetailModal';
import { Backdrop, ModalShell } from '../../components/Modal';
import type { LibraryEntry } from '../../api/types';
import type { NavigateToView } from '../WorkspacePage';

/**
 * The planning control center.
 *
 * Top row: the three metric widgets with their rings — Planning readiness, Approach, Planning
 * documents. Below: planning progress, the PM Actions (five, with a full screen behind "View all"),
 * and the two-tier Standards. Everything else is opt-in through Customize and renders underneath.
 *
 * Plan history is not here any more: it is step 5 of the planning flow in the sidebar, once the plan
 * is confirmed.
 */

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
 * How the readiness percentage was built, in the PM's words. The server decides which applies
 * (`workspace.basis`); this only names it, so the figure and the explanation cannot disagree.
 */
const READINESS_BASIS: Record<string, { label: string; help: string }> = {
  CUSTOMER_AND_FPT: {
    label: '60% customer standard + 40% FPT standard',
    help: 'Weighted 60% on how far this project meets the standards its customer set, and 40% on the FPT standard — the expected planning documents the PM has confirmed.',
  },
  FPT_ONLY: {
    label: 'FPT standard',
    help: 'This project’s customer has no checklist in the library, so the score is the FPT standard alone: the share of expected planning documents the PM has confirmed.',
  },
  CUSTOMER_AND_OUTPUTS: {
    label: '60% customer standard + 40% approved documents',
    help: 'The Planning Assessment has not been run, so the FPT half falls back to the share of documents approved. Run the assessment for the real figure.',
  },
  NOT_ASSESSED: {
    label: 'Approved documents only — not yet assessed',
    help: 'Nothing has been assessed against the FPT standard yet. Run the Planning Assessment to score this project properly.',
  },
};

const WIDGET_LABELS: [string, string, string][] = [
  ['readiness', 'Planning readiness', 'Default'],
  ['approach', 'Approach', 'Default'],
  ['outputs', 'Planning documents', 'Default'],
  ['tasks', 'Planning progress', 'Default'],
  ['decisions', 'PM Actions', 'Default'],
  ['standards', 'Standards (FPT → customer)', 'Default'],
  ['customer', 'Customer standard detail', 'Optional'],
  ['domains', 'Project information coverage', 'Optional'],
  ['library', 'Document list', 'Optional'],
  ['activity', 'Recent activity', 'Optional'],
];

/** How many PM actions the dashboard shows. The rest are one click away on their own screen. */
const DASHBOARD_ACTIONS = 5;

export function DashboardView({ projectId, onNavigate }: { projectId: string; onNavigate: NavigateToView }) {
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

  /** The document-list row the PM clicked; decides which of the two previews opens. */
  const [preview, setPreview] = useState<LibraryEntry | null>(null);
  /** Which standard's full list is open in the popup. */
  const [standardOpen, setStandardOpen] = useState<'FPT' | 'CUSTOMER' | null>(null);
  const { guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);
  const [removing, setRemoving] = useState<LibraryEntry | null>(null);

  /**
   * Deleting from the library, for both kinds of row. An upload loses its row, its extracted text
   * and its bytes on disk; a generated document is reset to "not generated" so it can be written
   * again, which moves Planning documents and reopens any PM action closed on its approval.
   */
  const removeEntry = useMutation({
    mutationFn: async (entry: LibraryEntry): Promise<{ restored: string[] }> => {
      if (entry.kind === 'GENERATED') {
        await documentsApi.remove(projectId, entry.id);
        return { restored: [] };
      }
      return inputApi.removeReference(projectId, entry.id);
    },
    onSuccess: (result, entry) => {
      ['dashboard', 'studio', 'workspace', 'input', 'assessment'].forEach((key) =>
        queryClient.invalidateQueries({ queryKey: [key, projectId] }),
      );
      if (entry.kind === 'GENERATED') queryClient.invalidateQueries({ queryKey: ['checklist', projectId] });
      setPreview((open) => (open && open.id === entry.id ? null : open));
      setRemoving(null);
      notify({
        title: entry.kind === 'GENERATED' ? 'Document deleted' : 'Upload deleted',
        detail:
          entry.kind === 'GENERATED'
            ? `${entry.name} is back to not generated. Planning documents and PM Actions have been updated.`
            : `${entry.name} and the text extracted from it are gone.${
                result.restored.length ? ` ${result.restored.join(', ')}, which it had replaced, is current again.` : ''
              }`,
      });
    },
    onError: (error) => notify({ title: 'Could not delete', detail: (error as Error).message }),
  });

  const previewDoc = useQuery({
    queryKey: ['document', projectId, preview?.id],
    queryFn: () => documentsApi.detail(projectId, preview!.id),
    enabled: preview?.kind === 'GENERATED',
  });

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

  // Only what is switched on. The server sends every key with its default filled in, so a missing key
  // is not a reason to show a block — optional ones stay off until the PM ticks them in Customize.
  const show = (key: string) => activeWidgets[key] === true;
  const basis = READINESS_BASIS[data.workspace.basis] ?? READINESS_BASIS.NOT_ASSESSED;
  const counts = data.actionCounts;
  const lastChange = data.activity[0]?.createdAt ?? data.assessment?.at ?? null;
  /**
   * Exactly one step is "now": the first one not yet done. Computed once so the "Step N of 5" label
   * and the highlighted circle cannot disagree — they would the moment steps finish out of order.
   */
  const currentStep = data.tasks.items.findIndex((item) => item.state !== 'DONE');

  return (
    <section className="view active">
      <div className="page-head dash-head">
        <div>
          <h1 className="dash-title">
            <span>Project Dashboard</span>
            <em>·</em>
            <b>Planning Overview</b>
          </h1>
        </div>
        <div className="dashboard-actions">
          {/*
            The newest audit event — the last moment anything in this project actually changed.
            Omitted rather than defaulted to today when there is none.
          */}
          {lastChange && (
            <span className="last-updated">
              Last updated <b>{new Date(lastChange).toLocaleDateString()}</b>
            </span>
          )}
          <button
            className="secondary icon-only"
            onClick={() => refetch()}
            title={isRefetching ? 'Refreshing…' : 'Refresh'}
            aria-label="Refresh"
          >
            ↻
          </button>
          <button
            className="secondary icon-only"
            onClick={() => setDrawerOpen(true)}
            title="Customize dashboard"
            aria-label="Customize dashboard"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* ---- the three metric widgets, with their rings ---------------------- */}
      <div className="metric-grid v2-metrics">
        {show('readiness') && (
          <article className="metric widget">
            <div className="metric-label">
              <span>PLANNING READINESS</span>
              <button className="help" title={basis.help}>
                ?
              </button>
            </div>
            {/*
              The ring and the way to the blockers, nothing else. How the figure is built stays one
              hover away on the "?" beside the label, rather than three lines of text on the tile.
            */}
            <div className="score-row">
              <Ring value={data.startReadiness.score} className="readiness-ring v2-ready" />
              <div>
                <button className="text-button" onClick={() => onNavigate('actions')}>
                  Review blockers →
                </button>
              </div>
            </div>
          </article>
        )}

        {show('approach') && (
          <article className="metric widget">
            <div className="metric-label">
              <span>APPROACH</span>
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
                {/* The rigor label is gone; before a decision the tile still says one is awaited. */}
                {!data.workspace.approach && <p>Awaiting PM decision</p>}
                {/* "Fit score" — the weighted total over the nine criteria, not how sure the model is. */}
                {data.workspace.recommendation && <small>Fit score {data.workspace.recommendation.confidence}%</small>}
              </div>
            </div>
            {/* Straight to the rationale itself — the Methodology Fit tab — not the assessment's Overview. */}
            <button className="text-button" onClick={() => onNavigate('approach', 'fit')}>
              View rationale →
            </button>
          </article>
        )}

        {show('outputs') && (
          <article className="metric widget">
            <div className="metric-label">
              <span>PLANNING DOCUMENTS</span>
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
            <button className="text-button" onClick={() => onNavigate('studio')}>
              Open Planning Documents →
            </button>
          </article>
        )}
      </div>

      <div className="dash-cols">
        {show('tasks') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>Planning progress</h2>
              </div>
              <span className="sub-note">
                {currentStep === -1 ? 'All steps complete' : `Step ${currentStep + 1} of ${data.tasks.total}`}
              </span>
            </div>
            <ol className="progress-steps">
              {data.tasks.items.map((task, index) => {
                const state = task.state === 'DONE' ? 'done' : index === currentStep ? 'now' : '';
                return (
                  <li key={task.id} className={`progress-step ${state}`}>
                    <span className="step-dot">{task.state === 'DONE' ? '✓' : index + 1}</span>
                    <div>
                      <strong>{task.title}</strong>
                      <span>{task.detail}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </article>
        )}

        {show('decisions') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>PM Actions</h2>
                <p>What to update, and why — AI prepares, the PM decides</p>
              </div>
              {data.actions.length > 0 && (
                <button className="ghost" onClick={() => onNavigate('actions')}>
                  View all {counts.total} →
                </button>
              )}
            </div>
            <PmActionList
              compact
              projectId={projectId}
              actions={data.actions.slice(0, DASHBOARD_ACTIONS)}
              onNavigate={onNavigate}
              empty="No open PM actions. They are built from what the Planning Assessment finds missing, plus any document a plan change leaves out of date."
            />
            {data.actions.length > 0 && (
              <div className="action-legend">
                <span>
                  <i className="req" />
                  Required {counts.required}
                </span>
                <span>
                  <i className="con" />
                  Conditional {counts.conditional}
                </span>
                {counts.stale > 0 && (
                  <span>
                    <i className="upd" />
                    Out of date {counts.stale}
                  </span>
                )}
                {counts.resolved > 0 && (
                  <span>
                    <i className="ok" />
                    Resolved {counts.resolved}
                  </span>
                )}
              </div>
            )}
          </article>
        )}

        {show('standards') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>Standards</h2>
              </div>
              <button className="ghost" onClick={() => onNavigate('approach')}>
                Assessment →
              </button>
            </div>

            {!data.standards ? (
              <div className="program-empty">
                Nothing has been assessed yet. Run the Planning Assessment to score this project against the FPT
                standard.
              </div>
            ) : (
              <>
                {/*
                  Precedence, and the numbers say so: the FPT baseline applies to every project, and
                  the customer's own checklist is laid on top of it. That order is what the readiness
                  formula weights 40/60.
                */}
                <div className="standard-row">
                  <span className="standard-order">1</span>
                  <div>
                    <div className="standard-title">
                      <strong>{data.standards.fpt.label}</strong>
                      <button className="link-button" onClick={() => setStandardOpen('FPT')}>
                        View detail
                      </button>
                    </div>
                    <small>{data.standards.fpt.note}</small>
                    <div className="standard-figure">
                      <span>Expected documents confirmed</span>
                      <b>{data.standards.fpt.score}%</b>
                    </div>
                    <div className="bar teal">
                      <i style={{ width: `${data.standards.fpt.score}%` }} />
                    </div>
                  </div>
                </div>

                {data.standards.customer ? (
                  <div className="standard-row">
                    <span className="standard-order">2</span>
                    <div>
                      <div className="standard-title">
                        <strong>{data.standards.customer.label}</strong>
                        <button className="link-button" onClick={() => setStandardOpen('CUSTOMER')}>
                          View detail
                        </button>
                      </div>
                      <small>
                        {data.standards.customer.note}
                        {data.standards.customer.stale && ' · needs re-check'}
                      </small>
                      <div className="standard-figure">
                        <span>Checklist items met</span>
                        <b>{data.standards.customer.score}%</b>
                      </div>
                      <div className="bar">
                        <i style={{ width: `${data.standards.customer.score}%` }} />
                      </div>
                    </div>
                  </div>
                ) : (
                  /* No second row reading 0% — there is nothing to measure against, not a failure. */
                  <div className="standard-row muted">
                    <span className="standard-order">2</span>
                    <div>
                      <strong>Customer standard</strong>
                      <small>
                        No checklist in the library for{' '}
                        {data.workspace.customer ? <b>{data.workspace.customer}</b> : 'this project’s customer'} — the
                        FPT standard is the whole score.
                      </small>
                    </div>
                  </div>
                )}
              </>
            )}
          </article>
        )}
      </div>

      {/* ---- optional widgets, below the fold by design ---------------------- */}
      <div className="dashboard-grid lower">
        {show('customer') && (
          <article className="widget wide">
            <CustomerReadinessPanel projectId={projectId} />
          </article>
        )}

        {show('domains') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>Project information coverage</h2>
                <p>How much of the intake profile is filled and verified</p>
              </div>
              <span className="sub-note">Target 80%</span>
            </div>
            <ul className="mini-list">
              {data.domains.map((domain) => (
                <li key={domain.domain}>
                  <span>{DOMAIN_LABEL[domain.domain] ?? domain.domain}</span>
                  <b>{domain.score}%</b>
                </li>
              ))}
            </ul>
          </article>
        )}

        {show('library') && (
          <article className="panel widget wide">
            <div className="panel-head">
              <div>
                <h2>Document list</h2>
                <p>Everything attached to this project — what you uploaded and what the AI wrote</p>
              </div>
              <span className="copilot-badge">{data.library.length} total</span>
              <button className="ghost" aria-expanded={libraryOpen} onClick={() => setLibraryOpen((open) => !open)}>
                {libraryOpen ? 'Hide detail' : 'View detail'}
              </button>
            </div>
            {!libraryOpen ? null : data.library.length === 0 ? (
              <div className="program-empty">
                Nothing yet. Upload reference files on Project Input, or generate a document in Planning Documents.
              </div>
            ) : (
              <div className="doc-library">
                {data.library.map((item) => (
                  <div className="library-row" key={`${item.kind}-${item.id}`}>
                    <button className="library-open" onClick={() => setPreview(item)} title="View document">
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
                    <button
                      className={`library-delete${lockClass}`}
                      {...lockedProps}
                      title={`Delete ${item.name}`}
                      aria-label={`Delete ${item.name}`}
                      onClick={guard(() => setRemoving(item))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </article>
        )}

        {show('activity') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>Recent activity</h2>
                <p>Traceable assessment, generation and PM actions</p>
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

      <div className={`dashboard-drawer customize-drawer${drawerOpen ? ' open' : ''}`}>
        <div className="drawer-head">
          <div>
            <strong>Customize dashboard</strong>
            <span>The default set fits one screen; optional blocks are added below it</span>
          </div>
          <button onClick={() => setDrawerOpen(false)}>×</button>
        </div>
        <div className="dashboard-options">
          {(['Default', 'Optional'] as const).map((group) => (
            <div key={group}>
              <div className="option-group">{group === 'Default' ? 'On one screen (default)' : 'Optional · shown below'}</div>
              {WIDGET_LABELS.filter(([, , g]) => g === group).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={activeWidgets[key] === true}
                    onChange={(event) => setWidgets({ ...activeWidgets, [key]: event.target.checked })}
                  />{' '}
                  {label}
                </label>
              ))}
            </div>
          ))}
        </div>
        <button className="primary full" onClick={() => saveLayout.mutate(activeWidgets)} disabled={saveLayout.isPending}>
          {saveLayout.isPending ? 'Saving…' : 'Save dashboard layout'}
        </button>
      </div>

      {preview?.kind === 'UPLOAD' && (
        <UploadPreview projectId={projectId} fileId={preview.id} fileName={preview.name} onClose={() => setPreview(null)} />
      )}
      {preview?.kind === 'GENERATED' && previewDoc.data && (
        <DocumentPreview
          document={previewDoc.data}
          projectId={projectId}
          projectName={data.workspace.name}
          onClose={() => setPreview(null)}
          onDownload={() => documentsApi.download(projectId, preview.id, preview.name, previewDoc.data.exportFormat)}
        />
      )}

      <StandardDetailModal projectId={projectId} standard={standardOpen} onClose={() => setStandardOpen(null)} />

      <Backdrop open={Boolean(removing)} onClose={() => setRemoving(null)} />
      <ModalShell open={Boolean(removing)} className="decision-modal">
        <div className="modal-head">
          <div>
            <small>{removing?.kind === 'GENERATED' ? 'DELETE DOCUMENT' : 'DELETE UPLOAD'}</small>
            <h2>{removing?.name}</h2>
          </div>
          <button onClick={() => setRemoving(null)}>×</button>
        </div>
        <div className="rationale">
          {removing?.kind === 'GENERATED' ? (
            <>
              <p>
                The draft, its sections and its PM questions are deleted. The catalog entry stays, so you can generate
                this document again from Planning Documents.
              </p>
              <p>
                Planning documents drops it from the approved count, the deletion is written to the activity log, and any
                PM action closed because this document was confirmed goes back to open.
              </p>
              {removing?.status === 'APPROVED' && (
                <p className="doc-note">
                  <b>This document is approved.</b> Deleting it removes it from the approved planning baseline, the FPT
                  standard score and the customer readiness score. The content cannot be recovered; only the audit
                  record of it survives.
                </p>
              )}
            </>
          ) : (
            <>
              <p>
                The file, the text extracted from it and the stored copy on disk are all deleted. This cannot be undone —
                you would have to upload the file again.
              </p>
              <p>
                Anything already produced from it stays as it is: a past assessment is a snapshot and a generated
                document keeps what it says.
              </p>
            </>
          )}
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={() => setRemoving(null)}>
            Keep it
          </button>
          <button className="primary danger" disabled={removeEntry.isPending} onClick={() => removing && removeEntry.mutate(removing)}>
            {removeEntry.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </ModalShell>
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
