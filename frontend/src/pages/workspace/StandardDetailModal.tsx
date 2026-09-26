import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assessmentApi, checklistApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import type { ChecklistAssessedItem, ChecklistStatus, RuleRow } from '../../api/types';

/**
 * Every item of one standard, in a popup — what "View detail" on the dashboard's Standards block
 * opens. The PM can tick an item themselves, or ask the AI to verify.
 *
 * **A tick outranks the AI and survives a re-run**, for both standards. That is the rule the
 * customer checklist already had (`setItemVerdict`), and the FPT side now works the same way
 * (`AssessmentOverride`): whether a requirement is met is sometimes something only the PM knows —
 * the CM plan is a wiki page, the security review happened in a meeting — and an AI re-run that
 * quietly undid the PM's answer would teach them not to give one.
 *
 * The FPT list leaves out rules the AI could not evaluate, as Missing Documents does; items that do
 * not apply are still listed, because the PM may disagree with that call. The customer list is shown
 * whole.
 */
export function StandardDetailModal({
  projectId,
  standard,
  onClose,
}: {
  projectId: string;
  /** Which standard's detail is open, or null when the popup is closed. */
  standard: 'FPT' | 'CUSTOMER' | null;
  onClose: () => void;
}) {
  return (
    <>
      <Backdrop open={Boolean(standard)} onClose={onClose} />
      <ModalShell open={Boolean(standard)} className="decision-modal standard-modal">
        {standard === 'FPT' && <FptStandard projectId={projectId} onClose={onClose} />}
        {standard === 'CUSTOMER' && <CustomerStandard projectId={projectId} onClose={onClose} />}
      </ModalShell>
    </>
  );
}

/** Both standards move the same figures, so a change to either refreshes the same screens. */
function useRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return () =>
    ['assessment', 'checklist', 'dashboard', 'workspace'].forEach((key) =>
      queryClient.invalidateQueries({ queryKey: [key, projectId] }),
    );
}

// ---------------------------------------------------------------------------
// FPT standard — the Missing Documents rules
// ---------------------------------------------------------------------------

/** Why an FPT rule is met or not, in one line — who decided it matters as much as the answer. */
function fptState(row: RuleRow): string {
  if (row.pmVerdict === 'MET') return 'Ticked by you';
  if (row.pmVerdict === 'NOT_MET') return 'Marked not met by you';
  if (row.resolution?.by === 'DOCUMENT') return `${row.targetDocument} confirmed`;
  if (row.resolution?.by === 'ACTION') return 'Resolved in PM Actions';
  if (row.status === 'PASS') return 'Met — found in the project input';
  if (row.status === 'FAIL') return row.targetDocument ? `Missing — ${row.targetDocument} to generate` : 'Missing';
  if (row.status === 'NOT_APPLICABLE') return 'Not applicable to this project';
  return 'Not evaluated — the input could not tell';
}

function FptStandard({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const notify = useToast();
  const refresh = useRefresh(projectId);
  const { guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);

  const assessment = useQuery({
    queryKey: ['assessment', projectId],
    queryFn: () => assessmentApi.latest(projectId),
  });

  const tick = useMutation({
    mutationFn: ({ ruleId, met }: { ruleId: string; met: boolean }) => assessmentApi.setRule(projectId, ruleId, met),
    onSuccess: refresh,
    onError: (error) => notify({ title: 'Could not save your verdict', detail: (error as Error).message }),
  });

  const run = useMutation({
    mutationFn: () => assessmentApi.run(projectId),
    onSuccess: () => {
      refresh();
      notify({ title: 'Assessment re-run', detail: 'The AI checked every rule again. Your ticks were kept.' });
    },
    onError: (error) =>
      notify({ title: 'Could not run the assessment', detail: error instanceof ApiError ? error.message : String(error) }),
  });

  const data = assessment.data?.assessment ?? null;
  /**
   * Not-evaluated rules are left out, as they are in Missing Documents: the input could not tell
   * either way, and a row saying so only makes the PM wonder whether something is wrong. They appear
   * once Project Input is updated and the assessment re-run. A rule the PM ticked reads PASS, not
   * UNKNOWN, so a tick is never hidden by this.
   */
  const rows = (data?.rows ?? []).filter((row) => row.category === 'MISSING_DOCUMENT' && row.status !== 'UNKNOWN');
  const score = data?.categories.MISSING_DOCUMENT;
  const sections = [
    { title: 'Required for every project', rows: rows.filter((row) => !row.appliesWhen) },
    { title: 'Required only in specific situations', rows: rows.filter((row) => row.appliesWhen) },
  ];

  return (
    <>
      <div className="modal-head">
        <div>
          <small>STANDARD 1 · COMPANY BASELINE</small>
          <h2>FPT standards</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>

      <div className="standard-summary">
        <div>
          <strong>{data ? `${data.standards.fpt.score}%` : '—'}</strong>
          <span>
            {score ? `${score.passed} of ${score.assessed} applicable documents in place` : 'Not assessed yet'}
          </span>
        </div>
        <p>
          The planning documents Process_Software Project Management v5.0 expects. Tick one yourself when you know it
          is in place, or ask the AI to check the project input again. Your ticks are kept across re-runs. Checks the
          input could not answer are not listed — update Project Input and re-assess to see them.
        </p>
        <button
          className={`primary${lockClass}`}
          {...lockedProps}
          onClick={guard(() => run.mutate())}
          disabled={run.isPending}
          title="Runs every Planning Assessment check again — four model calls"
        >
          {run.isPending ? '✦ Assessing…' : '✦ Run assessment'}
        </button>
      </div>

      {assessment.isLoading ? (
        <div className="state-block">
          <span className="inline-spinner" /> Loading…
        </div>
      ) : !data ? (
        <div className="program-empty">Nothing has been assessed yet. Run the assessment to check this standard.</div>
      ) : (
        <div className="standard-list">
          {sections.filter((section) => section.rows.length > 0).map((section) => (
            <div key={section.title} className="standard-section">
              <h4>{section.title}</h4>
              <ul>
                {section.rows.map((row) => {
                  const met = row.status === 'PASS';
                  return (
                    <li key={row.ruleId} className={`standard-item${met ? ' is-met' : ''}`}>
                      <label>
                        <input
                          type="checkbox"
                          checked={met}
                          aria-disabled={Boolean(lockClass) || undefined}
                          disabled={tick.isPending}
                          onChange={guard(() => tick.mutate({ ruleId: row.ruleId, met: !met }))}
                        />
                        <span className="standard-text">
                          <b>{row.name}</b>
                          <small>
                            {row.ruleId} · {fptState(row)}
                            {row.appliesWhen && ` · only when ${row.appliesWhen.toLowerCase()}`}
                          </small>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Customer standard — the matched customer's own checklist
// ---------------------------------------------------------------------------

const CHECKLIST_STATE: Record<ChecklistStatus, string> = {
  MET: 'Met',
  PARTIAL: 'Partly met',
  NOT_MET: 'Not met',
  NOT_APPLICABLE: 'Not applicable',
  UNKNOWN: 'Not checked',
};

const CHECKLIST_SOURCE: Record<string, string> = {
  DETERMINISTIC: 'matched from project inputs',
  AI: 'assessed by the AI',
  PM: 'confirmed by you',
};

function CustomerStandard({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const notify = useToast();
  const refresh = useRefresh(projectId);
  const { guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);

  const readiness = useQuery({
    queryKey: ['checklist', projectId],
    queryFn: () => checklistApi.readiness(projectId),
  });

  const tick = useMutation({
    mutationFn: ({ itemId, status }: { itemId: string; status: ChecklistStatus }) =>
      checklistApi.setItem(projectId, itemId, status),
    onSuccess: refresh,
    onError: (error) => notify({ title: 'Could not save your verdict', detail: (error as Error).message }),
  });

  const assess = useMutation({
    mutationFn: (onlyUnmet: boolean) => checklistApi.assess(projectId, onlyUnmet),
    onSuccess: (result) => {
      refresh();
      notify({
        title: 'Customer checklist re-assessed',
        detail:
          result.provider === 'anthropic'
            ? `${result.sentToModel} item(s) went to the AI. Your ticks were kept.`
            : 'No AI provider is configured, so only items matched directly from project inputs were checked.',
      });
    },
    onError: (error) =>
      notify({ title: 'Could not re-assess', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const data = readiness.data;
  const bySection = new Map<string, ChecklistAssessedItem[]>();
  if (data?.applies) {
    for (const item of data.items) {
      const key = item.sectionEn ?? item.section ?? 'Ungrouped';
      bySection.set(key, [...(bySection.get(key) ?? []), item]);
    }
  }

  return (
    <>
      <div className="modal-head">
        <div>
          <small>STANDARD 2 · APPLIED ON TOP OF THE FPT BASELINE</small>
          <h2>{data?.applies ? `${data.customer.name} standards` : 'Customer standards'}</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>

      {readiness.isLoading ? (
        <div className="state-block">
          <span className="inline-spinner" /> Loading…
        </div>
      ) : !data?.applies ? (
        <div className="program-empty">{data?.reason ?? 'No customer checklist applies to this project.'}</div>
      ) : (
        <>
          <div className="standard-summary">
            <div>
              <strong>{data.score.score}%</strong>
              <span>
                of {data.score.applicable} applicable items · {data.checklist.name} v{data.checklist.version}
              </span>
            </div>
            <p>
              The criteria {data.customer.name} sets for the projects they commission. Tick an item yourself when you
              know it is met, or ask the AI to check. Your ticks are kept across re-runs.
            </p>
            <div className="standard-buttons">
              <button
                className={`secondary${lockClass}`}
                {...lockedProps}
                disabled={assess.isPending}
                onClick={guard(() => assess.mutate(true))}
              >
                {assess.isPending ? '✦ Assessing…' : '✦ Assess new evidence'}
              </button>
              <button
                className={`primary${lockClass}`}
                {...lockedProps}
                disabled={assess.isPending}
                onClick={guard(() => assess.mutate(false))}
              >
                ✦ Re-assess everything
              </button>
            </div>
          </div>

          <div className="standard-list">
            {[...bySection.entries()].map(([section, items]) => (
              <div key={section} className="standard-section">
                <h4>
                  {section}
                  <span>
                    {items.filter((item) => item.status === 'MET').length}/{items.length} met
                  </span>
                </h4>
                <ul>
                  {items.map((item) => {
                    const met = item.status === 'MET';
                    return (
                      <li key={item.id} className={`standard-item${met ? ' is-met' : ''}`}>
                        <label>
                          <input
                            type="checkbox"
                            checked={met}
                            aria-disabled={Boolean(lockClass) || undefined}
                            disabled={tick.isPending}
                            // Unticking records "not met" — the PM's own answer — rather than
                            // clearing it, because a cleared item would go back to whatever the AI said.
                            onChange={guard(() => tick.mutate({ itemId: item.id, status: met ? 'NOT_MET' : 'MET' }))}
                          />
                          <span className="standard-text">
                            <b>{item.textEn ?? item.text}</b>
                            {item.textEn && <small className="readiness-original">{item.text}</small>}
                            <small>
                              {CHECKLIST_STATE[item.status]}
                              {item.source ? ` · ${CHECKLIST_SOURCE[item.source] ?? item.source}` : ''}
                            </small>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
