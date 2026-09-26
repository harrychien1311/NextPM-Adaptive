import { useMutation, useQueryClient } from '@tanstack/react-query';
import { planChangeApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import { ApiError } from '../../api/client';
import type { PlanChange } from '../../api/types';
import type { NavigateToView } from '../WorkspacePage';

/**
 * Change impact — what an applied change would do to a plan that already exists.
 *
 * It lives on the `approach` route rather than in a nav item of its own, because it *is* the output
 * of an analysis and shows the same four things Planning Review shows, expressed as a delta. The
 * mode is decided by data — a `PlanChange` in ANALYZED state — so a refresh or a bookmarked link
 * lands in the right place, and applying the change returns the screen to Planning Review showing
 * the merged snapshot.
 *
 * Nothing here has happened yet. The delta is a proposal until the PM presses Apply, exactly like
 * the recommendation on the screen it replaces.
 */
export function PlanChangeView({
  projectId,
  change,
  onNavigate,
  onEdit,
}: {
  projectId: string;
  change: PlanChange;
  onNavigate: NavigateToView;
  /** Returns to the change recorder in Update Planning, to edit what was recorded. */
  onEdit?: () => void;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const { canWrite, guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);
  const impact = change.impact;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['plan-change', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['plan-changes', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['approach', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['studio', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
      // Applying can move Missing Information / Missing Documents and the PM actions they drive.
      queryClient.invalidateQueries({ queryKey: ['assessment', projectId] }),
    ]);
  };

  const apply = useMutation({
    mutationFn: () => planChangeApi.apply(projectId, change.id),
    onSuccess: async (result) => {
      await refresh();
      notify({
        title: 'Plan updated',
        // Missing Information / Missing Documents follow the change in the same step; risks and
        // conflicts are not re-judged (that is Re-assess, which costs model calls), so say so.
        detail: result.assessment
          ? `${result.flagged} document(s) flagged as out of date. Planning Assessment updated: ${result.assessment.nowMissing} now missing, ${result.assessment.settled} settled — PM actions follow. Risks and conflicts refresh on Re-assess.`
          : `${result.flagged} document(s) flagged as out of date. The change moved nothing in Missing Information or Missing Documents.`,
      });
    },
    onError: (error) =>
      notify({ title: 'Could not apply the change', detail: error instanceof ApiError ? error.message : String(error) }),
  });

  const dismiss = useMutation({
    mutationFn: () => planChangeApi.dismiss(projectId, change.id),
    onSuccess: async () => {
      await refresh();
      notify({ title: 'Change dismissed', detail: 'The plan is unchanged; the record of it is kept.' });
    },
    onError: (error) => notify({ title: 'Could not dismiss', detail: (error as Error).message }),
  });

  if (!impact) {
    return (
      <section className="view active">
        <div className="program-empty">This change has not been analysed yet.</div>
      </section>
    );
  }

  const nothingMoved =
    !impact.changedOverview.length &&
    !impact.newGaps.length &&
    !impact.closedGaps.length &&
    !impact.newFindings.length &&
    !impact.affectedDocuments.length &&
    !impact.assessmentUpdates?.length;
  const assessmentUpdates = impact.assessmentUpdates ?? [];

  return (
    <section className="view active">
      <div className="page-head">
        <div>
          <p>PLANNING FLOW 4 · UPDATE PLANNING · CHANGE IMPACT</p>
          <h1>What this change does to the plan</h1>
          <span>{impact.summary}</span>
        </div>
        <div className="decision-status">
          <span>Documents affected</span>
          <strong>{impact.affectedDocuments.length}</strong>
        </div>
      </div>

      {nothingMoved && (
        /* A real and useful answer. The alternative — inventing movement so the screen has
           something on it — is the failure this whole application is written to avoid. */
        <div className="cost-policy">
          <span>✓</span>
          <div>
            <strong>Nothing in the plan needs to move</strong>
            <p>
              The change is recorded, but it does not alter the project’s scope, gaps or governance
              model, and no generated document is affected by it.
            </p>
          </div>
        </div>
      )}

      <article className="panel widget">
        <div className="panel-head">
          <div>
            <h2>What changed</h2>
            <p>Only the blocks that moved — each with what the previous analysis said</p>
          </div>
        </div>
        {impact.changedOverview.length === 0 ? (
          <div className="program-empty">No part of the project overview changed.</div>
        ) : (
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
                {block.points.length > 0 && (
                  <ul>
                    {block.points.map((point, index) => (
                      <li key={index}>{point}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </article>

      <div className="dashboard-grid">
        <article className="panel widget">
          <div className="panel-head">
            <div>
              <h2>Planning gaps</h2>
              <p>What the change opens and what it settles</p>
            </div>
            <span className="count-pill">
              +{impact.newGaps.length} / −{impact.closedGaps.length}
            </span>
          </div>
          {impact.newGaps.length === 0 && impact.closedGaps.length === 0 ? (
            <div className="program-empty">The change neither opens nor closes a gap.</div>
          ) : (
            <>
              {impact.newGaps.map((gap, index) => (
                <div className="decision-item critical" key={`new-${index}`}>
                  <span>+</span>
                  <div>
                    <small>{gap.severity} · NEW GAP</small>
                    <strong>{gap.title}</strong>
                    <p>{gap.why}</p>
                  </div>
                </div>
              ))}
              {impact.closedGaps.length > 0 && (
                <p className="doc-note">
                  {impact.closedGaps.length} previously open gap
                  {impact.closedGaps.length === 1 ? '' : 's'} {impact.closedGaps.length === 1 ? 'is' : 'are'} settled by
                  this change and will drop off the list when it is applied.
                </p>
              )}
            </>
          )}

          {impact.newFindings.length > 0 && (
            <>
              <div className="panel-head" style={{ marginTop: 18 }}>
                <div>
                  <h3>New contradictions</h3>
                  <p>Where the change disagrees with what was already on file</p>
                </div>
              </div>
              {impact.newFindings.map((finding, index) => (
                <div className="decision-item warning" key={`finding-${index}`}>
                  <span>◇</span>
                  <div>
                    <strong>{finding.title}</strong>
                    <p>{finding.detail}</p>
                    {finding.evidence.map((item, e) => (
                      <p className="evidence-line" key={e}>
                        {item.english}
                        {item.original && <em>{item.original}</em>}
                        <span className="evidence-source">{item.source}</span>
                      </p>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </article>

        <article className="panel widget">
          <div className="panel-head">
            <div>
              <h2>Governance model</h2>
              <p>Does the model in force still fit what the project has become?</p>
            </div>
          </div>
          <div className={`cost-policy${impact.approach.stillFits ? '' : ' approach-warning'}`}>
            <span>{impact.approach.stillFits ? '✓' : '!'}</span>
            <div>
              <strong>
                {impact.approach.stillFits ? 'Still fits' : 'May no longer fit'}
                {impact.approach.score ? ` · ${impact.approach.score}% fit` : ''}
              </strong>
              <p>{impact.approach.note}</p>
              {impact.approach.suggested && (
                /* A suggestion and nothing more. Changing the governance model is the PM decision
                   gate (`ApproachDecision`); a plan change must not walk through it. */
                <p>
                  Consider <b>{impact.approach.suggested}</b> instead — applying this change does not
                  switch it. Re-decide on Planning Assessment if you agree.
                </p>
              )}
            </div>
          </div>
        </article>
      </div>

      <article className="panel widget">
        <div className="panel-head">
          <div>
            <h2>Documents affected</h2>
            <p>What would go out of date if you applied this change — nothing has been flagged yet</p>
          </div>
          <span className="count-pill">{impact.affectedDocuments.length}</span>
        </div>
        {impact.affectedDocuments.length === 0 ? (
          <div className="program-empty">No generated document is affected by this change.</div>
        ) : (
          /*
            No way through to the Studio from here, deliberately.

            Nothing has been applied yet: the snapshot has not moved, the documents carry no stale
            flag, and the Studio would show each one exactly as it was before the change — so
            regenerating from there would produce a draft written against the old plan, which is
            worse than not offering the trip at all. The route opens once the change is applied,
            from the amber banner on the document and from the PM action center.
          */
          impact.affectedDocuments.map((entry) => (
            <div
              className={`decision-item ${entry.severity === 'HIGH' ? 'critical' : entry.severity === 'MEDIUM' ? 'warning' : 'info'}`}
              key={entry.documentName}
            >
              <span>{entry.severity === 'HIGH' ? '!' : entry.severity === 'MEDIUM' ? '◇' : 'i'}</span>
              <div>
                <small>{entry.severity} · WOULD GO OUT OF DATE</small>
                <strong>{entry.documentName}</strong>
                <p>{entry.reason}</p>
              </div>
            </div>
          ))
        )}
      </article>

      {/*
        What the change does to the Planning Assessment's Missing Information and Missing Documents —
        only the items it moves. Applied on Apply, with the PM actions they drive; every other item
        keeps its last assessed result.
      */}
      <article className="panel widget">
        <div className="panel-head">
          <div>
            <h2>Planning Assessment</h2>
            <p>Missing information and missing documents this change would move</p>
          </div>
          <span className="count-pill">{assessmentUpdates.length}</span>
        </div>
        {impact.assessmentUpdates === undefined ? (
          <div className="program-empty">
            This change was analysed before the assessment was part of it — analyse it again to see its effect here.
          </div>
        ) : assessmentUpdates.length === 0 ? (
          <div className="program-empty">No missing information or missing document is affected by this change.</div>
        ) : (
          assessmentUpdates.map((update) => {
            const kind = update.ruleId.startsWith('MD-') ? 'DOCUMENT' : 'INFORMATION';
            const label =
              update.status === 'FAIL' ? 'NOW MISSING' : update.status === 'PASS' ? 'NOW PROVIDED' : 'NO LONGER APPLIES';
            return (
              <div className={`decision-item ${update.status === 'FAIL' ? 'critical' : 'info'}`} key={update.ruleId}>
                <span>{update.status === 'FAIL' ? '+' : '✓'}</span>
                <div>
                  <small>
                    {kind === 'DOCUMENT' ? 'MISSING DOCUMENT' : 'MISSING INFORMATION'} · {label}
                  </small>
                  <strong>{update.finding}</strong>
                  {update.status === 'FAIL' && update.action && (
                    <p>
                      {update.action}
                      {update.targetDocument ? ` — in ${update.targetDocument}` : ' — on Project Input'}
                    </p>
                  )}
                  {update.status === 'NOT_APPLICABLE' && update.applicability && <p>{update.applicability}</p>}
                </div>
              </div>
            );
          })
        )}
      </article>

      <div className="sticky-action">
        <div>
          <span>⇄</span>
          <p>
            Nothing has changed yet. <strong>Apply</strong> writes a new analysis snapshot, updates Missing
            Information and Missing Documents with the items above and the PM actions they drive, and flags
            the affected documents — each then carries a banner in Planning Artifacts, and you decide whether to
            regenerate it.
          </p>
        </div>
        {onEdit ? (
          <button className="secondary" onClick={onEdit}>
            ← Edit the change
          </button>
        ) : (
          <button className="secondary" onClick={() => onNavigate('update')}>
            ← Back to Update Planning
          </button>
        )}
        <button
          className={`secondary${lockClass}`}
          {...lockedProps}
          onClick={guard(() => dismiss.mutate())}
          disabled={canWrite && dismiss.isPending}
        >
          Discard change
        </button>
        <button
          className={`primary${lockClass}`}
          {...lockedProps}
          onClick={guard(() => apply.mutate())}
          disabled={canWrite && apply.isPending}
        >
          {apply.isPending ? 'Applying…' : 'Apply change'}
        </button>
      </div>
    </section>
  );
}
