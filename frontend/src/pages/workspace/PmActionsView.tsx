import { useQuery } from '@tanstack/react-query';
import { projectApi } from '../../api/endpoints';
import { PmActionList } from './PmActionList';
import type { NavigateToView } from '../WorkspacePage';

/**
 * Every PM action, on one screen — what the dashboard's "View all" opens.
 *
 * It reads the same dashboard payload the panel does, so the two can never list different actions,
 * and uses the same row component, so a button means the same thing in both places. Outstanding
 * actions come first; resolved ones follow under their own heading, waiting for Close, because a
 * green row mixed in among the outstanding ones is easy to mistake for one that still needs work.
 */
export function PmActionsView({ projectId, onNavigate }: { projectId: string; onNavigate: NavigateToView }) {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: () => projectApi.dashboard(projectId),
  });

  if (isLoading || !data) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading PM actions…
        </div>
      </section>
    );
  }

  const outstanding = data.actions.filter((action) => !action.resolved);
  const resolved = data.actions.filter((action) => action.resolved);
  const counts = data.actionCounts;

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PROJECT DASHBOARD · PM ACTIONS</p>
          <h1>Decisions only you can make.</h1>
          <span>
            Each one says what is missing and what to add. Open goes where the work happens; confirming the document
            in Planning Documents resolves it for you.
          </span>
        </div>
        <button className="secondary" onClick={() => onNavigate('dashboard')}>
          ← Back to dashboard
        </button>
      </div>

      <div className="action-summary">
        <span>
          <i className="req" /> Required <b>{counts.required}</b>
        </span>
        <span>
          <i className="con" /> Conditional <b>{counts.conditional}</b>
        </span>
        <span>
          <i className="upd" /> Out of date <b>{counts.stale}</b>
        </span>
        <span>
          <i className="ok" /> Resolved, not closed <b>{counts.resolved}</b>
        </span>
      </div>

      <article className="panel widget">
        <div className="panel-head">
          <div>
            <h2>Outstanding</h2>
            <p>Missing information and documents the Planning Assessment found, plus anything a plan change put out of date</p>
          </div>
          <span className="count-pill">{outstanding.length}</span>
        </div>
        <PmActionList
          projectId={projectId}
          actions={outstanding}
          onNavigate={onNavigate}
          empty="Nothing outstanding. Every action is resolved."
        />
      </article>

      {resolved.length > 0 && (
        <article className="panel widget">
          <div className="panel-head">
            <div>
              <h2>Resolved — ready to close</h2>
              <p>Handled by you, or by confirming the document it asked for. Close them to clear the list.</p>
            </div>
            <span className="count-pill">{resolved.length}</span>
          </div>
          <PmActionList projectId={projectId} actions={resolved} onNavigate={onNavigate} empty="" />
        </article>
      )}
    </section>
  );
}
