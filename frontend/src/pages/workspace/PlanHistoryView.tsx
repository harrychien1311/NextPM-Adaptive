import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { planChangeApi } from '../../api/endpoints';
import type { PlanChangeHistoryEntry } from '../../api/types';
import type { NavigateToView } from '../WorkspacePage';

/**
 * Plan history — every change ever recorded on this project, and what each one did.
 *
 * Its own screen rather than a panel, because a plan that has moved three times is a story with an
 * order to it, and reading "what did we change in September and why" beside today's dashboard
 * figures is not what a dashboard is for. It is reached from the dashboard and goes back there;
 * it deliberately has no nav item, because it is not a step in the flow.
 *
 * Dismissed changes are listed too. "We considered this and decided against it" is part of the
 * record, and a history that shows only what was accepted is a history that cannot be trusted.
 */

const STATUS_LABEL: Record<string, { label: string; tone: string }> = {
  APPLIED: { label: 'Applied', tone: 'approved-status' },
  DISMISSED: { label: 'Dismissed', tone: 'blocked-status' },
  ANALYZED: { label: 'Awaiting your decision', tone: 'review-status' },
  DRAFT: { label: 'Draft', tone: 'draft-status' },
};

export function PlanHistoryView({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: NavigateToView;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['plan-changes', projectId],
    queryFn: () => planChangeApi.history(projectId),
  });
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading plan history…
        </div>
      </section>
    );
  }

  const changes = data?.changes ?? [];

  return (
    <section className="view active">
      <div className="page-head">
        <div>
          <p>PLANNING FLOW 5 · PLAN HISTORY</p>
          <h1>How this plan has moved</h1>
          <span>
            {changes.length === 0
              ? 'No changes recorded yet.'
              : `${changes.length} change${changes.length === 1 ? '' : 's'} recorded`}
          </span>
        </div>
        {/* A step in the flow now, reached from the sidebar — so the way on is to record the next change. */}
        <button className="secondary" onClick={() => onNavigate('update')}>
          ⇄ Record a plan change
        </button>
      </div>

      {changes.length === 0 ? (
        <div className="program-empty">
          Nothing has changed since the plan was confirmed. When something does, record it on Project
          Input and it will appear here with what it affected.
        </div>
      ) : (
        <div className="history-list">
          {changes.map((change) => (
            <HistoryRow
              key={change.id}
              change={change}
              open={open === change.id}
              onToggle={() => setOpen(open === change.id ? null : change.id)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function HistoryRow({
  change,
  open,
  onToggle,
  onNavigate,
}: {
  change: PlanChangeHistoryEntry;
  open: boolean;
  onToggle: () => void;
  onNavigate: NavigateToView;
}) {
  const status = STATUS_LABEL[change.status] ?? STATUS_LABEL.DRAFT;
  const impact = change.impact;
  const at = change.appliedAt ?? change.analyzedAt ?? change.createdAt;
  /**
   * Only an applied change actually moved anything, and only its documents carry the stale flag —
   * so it is the only one whose entries lead anywhere. For a dismissed or still-open change the
   * impact is a reading of what *would* have happened, and everything it names is untouched.
   */
  const applied = change.status === 'APPLIED';

  return (
    <article className="panel history-entry">
      <header onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <div>
          <small>
            {new Date(at).toLocaleString()} · {change.createdBy.name}
          </small>
          <strong>{impact?.summary || change.note || 'Change recorded'}</strong>
          {change.documents.length > 0 && (
            <small className="history-files">
              {change.documents
                .map((document) =>
                  document.replacesFileName
                    ? `${document.fileName} (replaced ${document.replacesFileName})`
                    : document.fileName,
                )
                .join(' · ')}
            </small>
          )}
        </div>
        <span className={`doc-status ${status.tone}`}>{status.label}</span>
        <span className="disclosure">{open ? '▴' : '▾'}</span>
      </header>

      {open && (
        <div className="history-detail">
          {change.note && (
            <p className="history-note">
              <b>The PM wrote</b> {change.note}
            </p>
          )}

          {!impact ? (
            <p className="doc-note">This change was never analysed.</p>
          ) : (
            <>
              {impact.changedOverview.length > 0 && (
                <div className="change-blocks">
                  {impact.changedOverview.map((block) => (
                    <div className="change-block" key={block.key}>
                      <small>{block.label.toUpperCase()}</small>
                      {block.previous && (
                        <p className="change-previous">
                          <b>Was</b> {block.previous}
                        </p>
                      )}
                      <p className="change-now">
                        <b>Now</b> {block.summary}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <ul className="history-stats">
                <li>
                  <b>{impact.newGaps.length}</b> gap{impact.newGaps.length === 1 ? '' : 's'} opened
                </li>
                <li>
                  <b>{impact.closedGaps.length}</b> closed
                </li>
                <li>
                  <b>{impact.newFindings.length}</b> new contradiction
                  {impact.newFindings.length === 1 ? '' : 's'}
                </li>
                <li>
                  {impact.approach.stillFits ? 'Governance model unchanged' : 'Governance model questioned'}
                </li>
              </ul>

              {impact.affectedDocuments.length > 0 && (
                <>
                  {/*
                    "Would have affected" until the change was actually applied. A change that was
                    dismissed, or one still waiting on the PM, flagged nothing and moved nothing —
                    so there is no way through to the Studio either. Offering one would send the PM
                    to a document that is exactly as it always was, described as out of date.
                  */}
                  <h3>{applied ? 'Documents this affected' : 'Documents this would have affected'}</h3>
                  {impact.affectedDocuments.map((entry) => (
                    <div className="decision-item info" key={entry.documentName}>
                      <span>{entry.severity === 'HIGH' ? '!' : 'i'}</span>
                      <div>
                        <strong>{entry.documentName}</strong>
                        <p>{entry.reason}</p>
                      </div>
                      {applied && (
                        <div className="decision-buttons">
                          <button onClick={() => onNavigate('studio', entry.documentName)}>Open</button>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}

              {!applied && (
                <p className="doc-note">
                  {change.status === 'DISMISSED'
                    ? 'This change was set aside — none of the above was applied, and the plan carried on unchanged.'
                    : 'Nothing above has been applied yet. The plan, the gaps and every document are still as they were; apply it on Planning Assessment to make any of it take effect.'}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}
