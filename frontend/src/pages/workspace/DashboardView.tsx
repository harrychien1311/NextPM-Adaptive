import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectApi } from '../../api/endpoints';
import { Ring } from '../../components/Ring';
import { useToast } from '../../components/Toast';
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
};

const WIDGET_LABELS: [string, string][] = [
  ['readiness', 'Start readiness'],
  ['approach', 'Management approach'],
  ['outputs', 'Planning outputs'],
  ['tasks', 'Planning tasks'],
  ['decisions', 'PM decisions'],
  ['domains', 'Readiness by domain'],
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
              <button className="help" title="Based on verified inputs and PM-approved planning outputs.">
                ?
              </button>
            </div>
            <div className="score-row">
              <Ring value={data.startReadiness.score} className="readiness-ring v2-ready" />
              <div>
                <strong className={data.startReadiness.verdict.tone === 'green' ? '' : 'amber'}>
                  {data.startReadiness.verdict.label}
                </strong>
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
              <span>PLANNING OUTPUTS</span>
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
              <div className="program-empty">No open PM decisions right now.</div>
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
                </div>
                <button onClick={() => onNavigate(action.targetView)}>Resolve</button>
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
                <h2>Planning readiness by domain</h2>
                <p>Coverage of required, verified and approved information</p>
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

        {show('activity') && (
          <article className="panel widget">
            <div className="panel-head">
              <div>
                <h2>Agent &amp; approval activity</h2>
                <p>Traceable rule, generation and PM actions</p>
              </div>
              <span className="copilot-badge">✦ Copilot Studio</span>
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
