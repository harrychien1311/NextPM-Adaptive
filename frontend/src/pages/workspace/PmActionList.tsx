import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inputApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import type { ActionItem } from '../../api/types';
import type { NavigateToView } from '../WorkspacePage';

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
 * The PM action list — one component for the dashboard's five and the full *PM Actions* screen, so
 * the two can never disagree about what a button does.
 *
 * Every row has the same three controls, in the same order:
 *
 * - **Open** — goes where the work happens: the document to generate in Planning Documents, or
 *   Project Input for something the PM supplies.
 * - **Resolve** — the PM saying "this is handled", with a note on how. It turns **green on its own**
 *   when the document it asked for is confirmed in Planning Documents: approving that document is
 *   the PM answering the action, and making them say so twice would be busywork.
 * - **Close** — appears only once the action is resolved, and takes it off the list. Resolving and
 *   closing are two claims — "I dealt with it" and "I no longer need to see it" — so a resolved row
 *   stays until the PM chooses to clear it.
 *
 * A row derived from an out-of-date document has no stored action behind it, so it offers Open and
 * nothing else: it clears itself when the document is regenerated or deleted.
 */
export function PmActionList({
  projectId,
  actions,
  onNavigate,
  empty,
  compact = false,
}: {
  projectId: string;
  actions: ActionItem[];
  onNavigate: NavigateToView;
  empty: string;
  /**
   * The dashboard's version: the category line and the title, nothing else — five rows that read at
   * a glance. What to add, which document and how it was resolved are on the full PM Actions screen.
   * The buttons stay, so the dashboard is still where the PM can act.
   */
  compact?: boolean;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const { canWrite, guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);

  const [resolving, setResolving] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [closing, setClosing] = useState<ActionItem | null>(null);

  const refresh = () =>
    Promise.all(
      // The assessment reads resolutions live, so its rows turn "Resolved" with the action.
      ['dashboard', 'input', 'workspace', 'assessment'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key, projectId] }),
      ),
    );

  const resolve = useMutation({
    mutationFn: ({ actionId, value }: { actionId: string; value: string }) =>
      inputApi.resolveAction(projectId, actionId, value),
    onSuccess: async () => {
      await refresh();
      setResolving(null);
      setAnswer('');
      notify({ title: 'Action resolved', detail: 'It stays on the list, green, until you close it.' });
    },
    onError: (error) => notify({ title: 'Could not resolve the action', detail: (error as Error).message }),
  });

  const close = useMutation({
    mutationFn: (actionId: string) => inputApi.closeAction(projectId, actionId),
    onSuccess: async () => {
      await refresh();
      setClosing(null);
      notify({ title: 'Action closed', detail: 'It is off the list and recorded in the audit trail.' });
    },
    onError: (error) => notify({ title: 'Could not close the action', detail: (error as Error).message }),
  });

  if (actions.length === 0) return <div className="program-empty">{empty}</div>;

  return (
    <>
      {actions.map((action) => {
        const stale = action.kind === 'STALE_DOCUMENT';
        const byDocument = action.resolved && action.targetDocumentStatus === 'APPROVED';
        const tone = action.priority === 'REQUIRED' ? 'critical' : action.priority === 'CONDITIONAL' ? 'warning' : 'info';

        return (
          <div
            key={action.id}
            className={`decision-item ${tone}${action.resolved ? ' is-answered' : ''}${stale ? ' is-stale' : ''}${compact ? ' is-compact' : ''}`}
          >
            <span>{stale ? '⇄' : action.resolved ? '✓' : action.priority === 'REQUIRED' ? '!' : action.priority === 'CONDITIONAL' ? '◇' : 'i'}</span>
            <div>
              <small>
                {stale ? 'OUT OF DATE AFTER A PLAN CHANGE' : action.priority} · {DOMAIN_LABEL[action.domain]?.toUpperCase()}
              </small>
              {/* Why — the missing item, in the assessment's words. */}
              <strong>{action.title}</strong>
              {/* What to do about it — the specific content to add. */}
              {!compact && action.description && <p>{action.description}</p>}
              {!compact && action.targetDocument && !action.resolved && (
                <span className="action-doc">
                  {stale ? 'Regenerate' : 'Update'} <strong>{action.targetDocument}</strong> in Planning Artifacts
                </span>
              )}
              {!compact && action.resolved && (
                <span className="answered-pill">
                  Resolved ·{' '}
                  {byDocument ? (
                    <>
                      <strong>{action.targetDocument}</strong> confirmed by the PM
                    </>
                  ) : (
                    action.resolvedValue ?? 'by the PM'
                  )}
                </span>
              )}
              {!compact && stale && (
                <span className="stale-pill">
                  Clears when you regenerate <strong>{action.targetDocument}</strong> or delete it
                </span>
              )}

              {resolving === action.id && (
                <form
                  className="action-answer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (answer.trim()) resolve.mutate({ actionId: action.id, value: answer.trim() });
                  }}
                >
                  {/*
                    How it was handled, not just a tick: the note is kept, written into a matching
                    input field where the title names one, and logged — "done" with no record is how
                    a gap comes back a month later with nobody able to say what was decided.
                  */}
                  <input
                    autoFocus
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    placeholder="How is this covered? e.g. “Escalation path agreed with the customer on 12 Sep”"
                  />
                  {action.suggestions.map((suggestion) => (
                    <button key={suggestion} type="button" className="answer-chip" onClick={() => setAnswer(`Covered by ${suggestion}`)}>
                      Covered by {suggestion}
                    </button>
                  ))}
                  <div className="answer-actions">
                    <button type="submit" className="primary small" disabled={!answer.trim() || resolve.isPending}>
                      {resolve.isPending ? 'Saving…' : 'Mark resolved'}
                    </button>
                    <button type="button" className="ghost" onClick={() => setResolving(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>

            <div className="decision-buttons">
              <button
                onClick={() => onNavigate(action.targetView, action.targetDocument)}
                title={action.targetDocument ? `Open ${action.targetDocument} in Planning Artifacts` : 'Open Project Input'}
              >
                Open
              </button>
              {!stale && (
                /*
                  Green and inert once resolved. It stays visible rather than disappearing so the
                  three buttons keep their places — the PM should not have to hunt for Close.
                */
                <button
                  className={`${action.resolved ? 'resolve-done' : ''}${lockClass}`}
                  {...lockedProps}
                  aria-pressed={action.resolved}
                  onClick={guard(() => {
                    if (action.resolved) return;
                    setResolving(resolving === action.id ? null : action.id);
                    setAnswer('');
                  })}
                >
                  {action.resolved ? '✓ Resolved' : canWrite && resolving === action.id ? 'Cancel' : 'Resolve'}
                </button>
              )}
              {!stale && action.resolved && (
                <button className={`primary small${lockClass}`} {...lockedProps} onClick={guard(() => setClosing(action))}>
                  Close
                </button>
              )}
            </div>
          </div>
        );
      })}

      <Backdrop open={Boolean(closing)} onClose={() => setClosing(null)} />
      <ModalShell open={Boolean(closing)} className="decision-modal">
        <div className="modal-head">
          <div>
            <small>CLOSE PM ACTION</small>
            <h2>{closing?.title}</h2>
          </div>
          <button onClick={() => setClosing(null)}>×</button>
        </div>
        <div className="rationale">
          <p>
            {closing?.targetDocumentStatus === 'APPROVED' && !closing.resolvedValue ? (
              <>
                <strong>{closing.targetDocument}</strong> has been confirmed in Planning Artifacts, which is what this
                action asked for.
              </>
            ) : (
              <>You marked this resolved: “{closing?.resolvedValue}”.</>
            )}
          </p>
          <p>Closing takes it off the list. The record of how it was resolved stays in the activity log.</p>
        </div>
        <div className="modal-actions">
          <button className="secondary" onClick={() => setClosing(null)}>
            Keep it
          </button>
          <button className="primary" disabled={close.isPending} onClick={() => closing && close.mutate(closing.id)}>
            {close.isPending ? 'Closing…' : 'Close action'}
          </button>
        </div>
      </ModalShell>
    </>
  );
}
