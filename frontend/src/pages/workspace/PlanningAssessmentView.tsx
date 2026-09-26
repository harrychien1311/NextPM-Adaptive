import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { assessmentApi, rulesApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import type {
  Approach,
  AssessmentCategory,
  CategoryScore,
  DocumentStatus,
  EvidenceItem,
  RuleRow,
  RuleStatus,
  ScoredApproach,
} from '../../api/types';
import type { WorkspaceView } from '../WorkspacePage';

/**
 * Planning Assessment — the FPT rule catalog applied to this project, on six tabs.
 *
 * It replaces Planning Review, which showed one model's reading of the documents as free prose. The
 * same material is here, but every statement now traces to a numbered rule with a source, a
 * severity and a status, because "the AI thinks the escalation path is missing" and "check MD-012
 * of the planning checklist failed" are different claims to put in front of a PM — only the second
 * can be argued with.
 *
 *   Overview · Missing Information · Missing Documents · Risks · Conflicts · Methodology Fit
 *
 * **Two tabs are not rule categories, deliberately.** Overview summarises, and Methodology Fit is a
 * recommendation score rather than a governance check — the methodology guidance is explicit that a
 * low fit means *not enough information to recommend*, never a failure, so it must not be rendered
 * with the PASS/FAIL vocabulary the other four use.
 *
 * **`UNKNOWN` is not listed on any tab, and never folded into PASS or FAIL.** A check the input was
 * not enough to judge is left out of the lists, the tab counts and the scores alike — showing it as
 * "not evaluated" only made the PM wonder whether it was a finding. It reappears on its own once
 * the input is updated and the project re-assessed.
 */
/** The tabs a caller may open this screen on. Anything else lands on Overview. */
const TAB_KEYS = ['overview', 'information', 'documents', 'risks', 'conflicts', 'fit'];

export function PlanningAssessmentView({
  projectId,
  onNavigate,
  initialTab,
}: {
  projectId: string;
  onNavigate: (view: WorkspaceView) => void;
  /** Open on this tab — the dashboard's "View rationale" asks for 'fit'. */
  initialTab?: string | null;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const { canWrite, guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);

  const assessment = useQuery({
    queryKey: ['assessment', projectId],
    queryFn: () => assessmentApi.latest(projectId),
  });
  const approach = useQuery({
    queryKey: ['approach', projectId],
    queryFn: () => rulesApi.approach(projectId),
  });

  const [tab, setTab] = useState(initialTab && TAB_KEYS.includes(initialTab) ? initialTab : 'overview');
  const [selected, setSelected] = useState<Approach | null>(null);
  const [modal, setModal] = useState(false);
  const [rationale, setRationale] = useState('');
  /** Per-tab, so opening one rule's evidence does not collapse another's when the tab changes. */
  const [openRule, setOpenRule] = useState<string | null>(null);

  const data = assessment.data?.assessment ?? null;
  const evaluation = approach.data?.evaluation ?? null;

  const approaches: ScoredApproach[] = useMemo(
    () =>
      evaluation
        ? [
            {
              approach: evaluation.recommendedApproach,
              score: evaluation.confidence,
              reasons: evaluation.reasons,
              evidence: evaluation.evidence,
              criteria: (evaluation.candidateValues as unknown as ScoredApproach['criteria']) ?? [],
            },
            ...evaluation.alternatives.map((alternative) => ({
              approach: alternative.approach,
              score: alternative.score,
              reasons: (alternative as unknown as { reasons?: string[] }).reasons ?? [alternative.rationale],
              evidence: (alternative as unknown as { evidence?: EvidenceItem[] }).evidence ?? [],
              criteria: (alternative as unknown as { criteria?: ScoredApproach['criteria'] }).criteria ?? [],
            })),
          ]
        : [],
    [evaluation],
  );

  useEffect(() => {
    if (evaluation && !selected) setSelected(evaluation.recommendedApproach);
  }, [evaluation, selected]);

  const chosen = approaches.find((entry) => entry.approach === selected) ?? approaches[0];
  const pmChose = evaluation?.approachMode === 'PM_CHOSEN';

  const run = useMutation({
    mutationFn: () => assessmentApi.run(projectId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['assessment', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
      ]);
      notify({ title: 'Assessment re-run', detail: 'Every rule was evaluated against the current documents.' });
    },
    onError: (error) => notify({ title: 'Could not run the assessment', detail: (error as Error).message }),
  });

  const decide = useMutation({
    mutationFn: () =>
      rulesApi.decide(projectId, {
        approach: chosen.approach,
        outcome: 'CONFIRMED',
        rationale: rationale.trim() || undefined,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['approach', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['studio', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] }),
      ]);
      setModal(false);
      setRationale('');
      notify({
        title: `${titleCase(chosen.approach)} confirmed`,
        detail: 'Opening Planning Documents. These facts are now the generation contract.',
      });
      setTimeout(() => onNavigate('studio'), 350);
    },
    onError: (error) => notify({ title: 'Decision not saved', detail: (error as Error).message }),
  });

  if (assessment.isLoading || approach.isLoading) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading the planning assessment…
        </div>
      </section>
    );
  }

  const rowsFor = (category: AssessmentCategory) => (data?.rows ?? []).filter((row) => row.category === category);
  const counts = data?.categories ?? null;

  /**
   * The management approach as it stands: the confirmed decision when there is one, otherwise what
   * the analysis put forward. Where it came from is its own fact — the PM naming a model on Project
   * Input, the PM picking something other than the recommendation, or the AI's recommendation — and
   * so is whether the PM has confirmed it, because until then nothing is generated from it.
   */
  const decision = approach.data?.decision ?? null;
  const approachSummary: ApproachSummary | null = (() => {
    const name = decision?.approach ?? evaluation?.recommendedApproach;
    if (!name) return null;
    const source = pmChose
      ? 'PM input'
      : decision && evaluation && decision.approach !== evaluation.recommendedApproach
        ? 'PM choice'
        : 'AI recommendation';
    return {
      name: titleCase(name),
      source,
      fit: approaches.find((entry) => entry.approach === name)?.score ?? null,
      confirmed: decision ? { by: decision.decidedBy.name, at: decision.decidedAt } : null,
    };
  })();

  /**
   * The tab count is the number of rows that need attention — failures plus unresolved — not the
   * catalog size. A tab reading "35" when 33 of those passed tells the PM to go and look at
   * nothing.
   */
  // Findings only — a check the input could not answer is listed on no tab, so it is not counted.
  const openCount = (category: AssessmentCategory) => (counts ? counts[category].failed : 0);

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PLANNING FLOW 2 · PLANNING ASSESSMENT</p>
          <h1>{pmChose ? 'How your chosen approach fits.' : 'What this project needs before it starts.'}</h1>
          <span>
            {data
              ? `${data.rows.length} checks from ${assessment.data?.catalogSize ?? 0} in the FPT catalog · last run ${new Date(
                  data.at,
                ).toLocaleDateString()}`
              : 'Nothing has been assessed yet.'}
          </span>
        </div>
        <div className="assessment-head-actions">
          <button className={`secondary${lockClass}`} {...lockedProps} onClick={guard(() => run.mutate())} disabled={canWrite && run.isPending}>
            {run.isPending ? 'Assessing…' : '↻ Re-assess'}
          </button>
        </div>
      </div>

      {!data ? (
        <article className="panel">
          <div className="program-empty">
            Upload the project documents on Project Input, then press <b>Re-assess</b>. Every check on this screen is
            answered from the project data and those documents — nothing is assumed.
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => onNavigate('input')}>
              Go to Project Input
            </button>
            <button className={`primary${lockClass}`} {...lockedProps} onClick={guard(() => run.mutate())} disabled={canWrite && run.isPending}>
              {run.isPending ? 'Assessing…' : 'Run the assessment'}
            </button>
          </div>
        </article>
      ) : (
        <>
          <nav className="assessment-tabs" role="tablist">
            {(assessment.data?.tabs ?? []).map((entry) => (
              <button
                key={entry.key}
                role="tab"
                aria-selected={tab === entry.key}
                className={`assessment-tab${tab === entry.key ? ' active' : ''}`}
                onClick={() => {
                  setTab(entry.key);
                  setOpenRule(null);
                }}
              >
                {entry.label}
                {entry.category && <span className="tab-count">{openCount(entry.category)}</span>}
              </button>
            ))}
          </nav>

          {tab === 'overview' && (
            <OverviewTab
              counts={counts}
              standards={data.standards}
              evidence={data.evidence}
              approachSummary={approachSummary}
              evaluation={evaluation}
              onOpenTab={setTab}
              onNavigate={onNavigate}
            />
          )}

          {tab === 'information' && <RuleTab category="MISSING_INFORMATION" rows={rowsFor('MISSING_INFORMATION')} score={counts?.MISSING_INFORMATION} openRule={openRule} onToggle={setOpenRule} empty="Nothing was found missing where the project input was enough to judge." />}
          {tab === 'documents' && <RuleTab category="MISSING_DOCUMENT" rows={rowsFor('MISSING_DOCUMENT')} score={counts?.MISSING_DOCUMENT} openRule={openRule} onToggle={setOpenRule} empty="No document was found missing where the project input was enough to judge." />}
          {tab === 'risks' && <RuleTab category="PLANNING_RISK" rows={rowsFor('PLANNING_RISK')} score={counts?.PLANNING_RISK} openRule={openRule} onToggle={setOpenRule} empty="No planning risk was triggered." />}
          {tab === 'conflicts' && <RuleTab category="CONFLICT" rows={rowsFor('CONFLICT')} score={counts?.CONFLICT} openRule={openRule} onToggle={setOpenRule} empty="No two documents were found to disagree." />}

          {tab === 'fit' && (
            <MethodologyFitTab
              approaches={approaches}
              chosen={chosen}
              pmChose={pmChose}
              onSelect={guard((value: Approach) => setSelected(value))}
              lockClass={lockClass}
              lockedProps={lockedProps}
            />
          )}
        </>
      )}

      {/*
        The confirm gate. Nothing generated in Planning Documents exists until this is pressed, and
        the button says so: what it freezes is the assessment above as the contract the drafts are
        written from. A button labelled only "Open Planning Documents" would read as navigation, and
        a PM would press it expecting to look around.
      */}
      <div className="sticky-action">
        <div>
          <span>✦</span>
          <p>
            <strong>
              {approach.data?.decision
                ? `${titleCase(approach.data.decision.approach)} was ${approach.data.decision.outcome.toLowerCase()} by ${approach.data.decision.decidedBy.name}.`
                : `Confirming freezes this assessment and ${titleCase(chosen?.approach ?? 'the approach')} as the generation contract.`}
            </strong>
            <br />
            Planning Documents then opens with the documents these checks found missing.
          </p>
        </div>
        <button className="secondary" onClick={() => onNavigate('input')}>
          ← Back to inputs
        </button>
        <button
          className={`primary${lockClass}`}
          {...lockedProps}
          disabled={canWrite && !chosen}
          onClick={guard(() => setModal(true))}
        >
          Confirm and Open Planning Documents
        </button>
      </div>

      <Backdrop open={modal} onClose={() => setModal(false)} />
      <ModalShell open={modal} className="decision-modal">
        <div className="modal-head">
          <span className="agent-orb">✦</span>
          <div>
            <small>PM DECISION REQUIRED</small>
            <h2>Confirm {titleCase(chosen?.approach ?? '')}</h2>
          </div>
          <button className="close-modal" onClick={() => setModal(false)}>
            ×
          </button>
        </div>
        <div className="rationale">
          <p>
            This confirms the assessment above and freezes {titleCase(chosen?.approach ?? 'the approach')} as this
            project's governance model. Both become the contract every generated document is written from.
          </p>
          {counts && counts.MISSING_DOCUMENT.blockers > 0 && (
            <p className="confirm-warning">
              {counts.MISSING_DOCUMENT.blockers} blocking document check{counts.MISSING_DOCUMENT.blockers === 1 ? ' is' : 's are'} still
              failing. You can confirm anyway — they stay open on the dashboard.
            </p>
          )}
        </div>
        <label>
          PM rationale
          <textarea
            placeholder="Why this approach, in your words…"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={() => setModal(false)}>
            Cancel
          </button>
          <button className="primary" disabled={!canWrite || decide.isPending} onClick={() => decide.mutate()}>
            {decide.isPending ? 'Saving…' : 'Confirm & generate'}
          </button>
        </div>
      </ModalShell>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

interface ApproachSummary {
  name: string;
  source: 'PM input' | 'PM choice' | 'AI recommendation';
  fit: number | null;
  confirmed: { by: string; at: string } | null;
}

function OverviewTab({
  counts,
  standards,
  evidence,
  approachSummary,
  evaluation,
  onOpenTab,
  onNavigate,
}: {
  counts: Record<AssessmentCategory, CategoryScore> | null;
  standards: { fpt: { score: number }; customer: { label: string; score: number } | null; readiness: number; basis: string };
  evidence: { files: number; readable: number } | undefined;
  approachSummary: ApproachSummary | null;
  evaluation: { overview?: { key: string; label: string; summary: string; points: string[] }[] } | null;
  onOpenTab: (tab: string) => void;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const overview = evaluation?.overview ?? [];

  return (
    <>
      <div className="assessment-tiles">
        <article className="panel tile">
          <span className="tile-label">Planning readiness</span>
          <strong className="tile-value">{standards.readiness}%</strong>
          <span className="tile-note">
            {standards.customer ? '60% customer standard + 40% FPT standard' : 'FPT standard only — no customer checklist'}
          </span>
        </article>
        {/* The same outstanding counts as the two tabs' badges — resolved items are not in them. */}
        <article className="panel tile">
          <span className="tile-label">Information gaps</span>
          <strong className="tile-value">{counts?.MISSING_INFORMATION.failed ?? 0}</strong>
          <span className="tile-note">Facts the project input does not state yet</span>
        </article>
        <article className="panel tile">
          <span className="tile-label">Missing documents</span>
          <strong className="tile-value">{counts?.MISSING_DOCUMENT.failed ?? 0}</strong>
          <span className="tile-note">Expected documents not yet provided or confirmed</span>
        </article>
      </div>

      <div className="review-split">
        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Project context</h2>
              <p>Read from the uploaded documents — not from what anyone typed into the form</p>
            </div>
          </div>
          {overview.length === 0 ? (
            <div className="program-empty">
              The documents did not support an overview. Run <b>✦ Analyze planning needs</b> on Project Input.
            </div>
          ) : (
            <ul className="context-list">
              {overview.map((section) => (
                <li key={section.key}>
                  <strong>{section.label}</strong>
                  <p>{section.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <div>
              <h2>Assessment summary</h2>
              <p>Every category, and what it found</p>
            </div>
          </div>
          {counts && (
            <ul className="summary-list">
              {/* What the assessment was read from, first — every figure below is only as good as it. */}
              {evidence && (
                <li>
                  <button className="summary-row" onClick={() => onNavigate('input')}>
                    <span>Project evidence</span>
                    <span className="summary-figures">
                      <b>{evidence.files}</b> file{evidence.files === 1 ? '' : 's'} uploaded
                      {evidence.readable < evidence.files && <em>· {evidence.files - evidence.readable} unreadable</em>}
                    </span>
                  </button>
                </li>
              )}
              {approachSummary && (
                <li>
                  <button className="summary-row" onClick={() => onOpenTab('fit')}>
                    <span>Management approach</span>
                    <span className="summary-figures summary-approach">
                      <b>{approachSummary.name}</b>
                      <em>· {approachSummary.source}</em>
                      {approachSummary.fit !== null && <em>· {approachSummary.fit}% fit</em>}
                      <span
                        className={`approach-status ${approachSummary.confirmed ? 'confirmed' : 'pending'}`}
                        title={
                          approachSummary.confirmed
                            ? `Confirmed by ${approachSummary.confirmed.by} on ${new Date(approachSummary.confirmed.at).toLocaleDateString()}`
                            : 'Nothing is generated from it until the PM confirms'
                        }
                      >
                        {approachSummary.confirmed ? 'Confirmed by PM' : 'Not confirmed by PM'}
                      </span>
                    </span>
                  </button>
                </li>
              )}
              {(
                [
                  ['MISSING_INFORMATION', 'Missing information', 'information'],
                  ['MISSING_DOCUMENT', 'Missing documents', 'documents'],
                  ['PLANNING_RISK', 'Planning risks', 'risks'],
                  ['CONFLICT', 'Conflicts', 'conflicts'],
                ] as [AssessmentCategory, string, string][]
              ).map(([category, label, tabKey]) => (
                <li key={category}>
                  <button className="summary-row" onClick={() => onOpenTab(tabKey)}>
                    <span>{label}</span>
                    <span className="summary-figures">
                      {FAIL_HEADLINE[category](counts[category].failed)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {/*
            No "Open Planning Documents" here. The only way forward from this screen is the confirm
            in the action bar: the PM confirming is what turns this assessment into the facts the
            documents are generated from, and a plain navigation button beside it would be a way
            round that.
          */}
        </article>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// One rule category
// ---------------------------------------------------------------------------

/**
 * What a failed and a passed rule are called, per category. "Open" said nothing about what kind of
 * problem a row was; a missing fact, a missing document, a risk and a conflict are different things
 * for the PM to do something about, and the label is the first thing they read.
 */
const FAIL_LABEL: Record<AssessmentCategory, string> = {
  MISSING_INFORMATION: 'Missing',
  MISSING_DOCUMENT: 'Missing',
  PLANNING_RISK: 'Risk found',
  CONFLICT: 'Conflict found',
};
const PASS_LABEL: Record<AssessmentCategory, string> = {
  MISSING_INFORMATION: 'Stated',
  MISSING_DOCUMENT: 'Provided',
  PLANNING_RISK: 'Not triggered',
  CONFLICT: 'Consistent',
};
/** The tab headline: "3 missing", "2 risks found". */
const FAIL_HEADLINE: Record<AssessmentCategory, (n: number) => string> = {
  MISSING_INFORMATION: (n) => `${n} missing`,
  MISSING_DOCUMENT: (n) => `${n} missing`,
  PLANNING_RISK: (n) => `${n} risk${n === 1 ? '' : 's'} found`,
  CONFLICT: (n) => `${n} conflict${n === 1 ? '' : 's'} found`,
};

function statusLabel(row: RuleRow) {
  if (row.resolution) return 'Resolved';
  if (row.status === 'FAIL') return FAIL_LABEL[row.category];
  if (row.status === 'PASS') return PASS_LABEL[row.category];
  if (row.status === 'UNKNOWN') return 'Not evaluated';
  if (row.status === 'NOT_APPLICABLE') return 'Not applicable';
  return 'Overridden';
}

/** Needs the PM: a risk or conflict found. Everything else listed is settled. */
const needsAttention = (row: RuleRow) => row.status === 'FAIL';

function RuleTab({
  category,
  rows: allRows,
  score,
  openRule,
  onToggle,
  empty,
}: {
  category: AssessmentCategory;
  rows: RuleRow[];
  score?: CategoryScore;
  openRule: string | null;
  onToggle: (ruleId: string | null) => void;
  empty: string;
}) {
  /**
   * Settled rules — met, resolved, not applicable — are collapsed behind a toggle rather than
   * removed. "Was this checked?" and "was it checked and found fine?" must not be the same answer,
   * which is the first question anyone auditing a planning review asks, but putting forty settled
   * rows above the six that need work buries the work.
   */
  const [showSettled, setShowSettled] = useState(false);
  const actionable = category === 'MISSING_INFORMATION' || category === 'MISSING_DOCUMENT';
  let rows = allRows;
  /**
   * Missing Information and Missing Documents list only what the assessment actually concluded is
   * missing — including items since resolved, so the PM sees them done. A check the input was not
   * enough to judge is left out entirely: listing it as "not evaluated" only made the PM wonder
   * whether it was missing, and it reappears on its own once the input is updated and re-assessed.
   * With every row missing, a "Missing" tag on each would say nothing, so there are no tags.
   */
  // Found missing by the AI, or marked not met by the PM in the Standards popup.
  if (actionable) rows = rows.filter((row) => row.assessedStatus === 'FAIL' || row.status === 'FAIL');
  // Risks and conflicts, by the same reasoning: a check the input could not answer is not listed —
  // only what was found, and (behind the toggle) what was checked and found fine.
  else rows = rows.filter((row) => row.status !== 'UNKNOWN');
  const attention = actionable ? rows.filter((row) => !row.resolution) : rows.filter(needsAttention);
  const settled = actionable ? [] : rows.filter((row) => !needsAttention(row));
  const missing = rows.filter((row) => row.status === 'FAIL').length;

  /**
   * Missing Documents is split by applicability, because the two halves are different claims. A
   * document required for every project is missing, full stop; one required only in a specific
   * situation (an AI project, supplier-controlled delivery, translation scope) is missing only
   * because the assessment decided that situation holds here — and the PM needs to see that
   * decision to be able to dispute it.
   */
  const sections: { title: string | null; note: string | null; rows: RuleRow[] }[] =
    category === 'MISSING_DOCUMENT'
      ? [
          {
            title: 'Required for every project',
            note: 'The FPT process requires these whatever the project type.',
            rows: rows.filter((row) => !row.appliesWhen),
          },
          {
            title: 'Required only in specific situations',
            note: 'Each applies only when its condition holds for this project — the assessment says whether it does.',
            rows: rows.filter((row) => Boolean(row.appliesWhen)),
          },
        ]
      : [{ title: null, note: null, rows }];

  return (
    <article className="panel">
      <div className="panel-head">
        <div>
          {actionable ? (
            <>
              <h2>
                {missing} to add{rows.length > missing ? ` · ${rows.length - missing} resolved` : ''}
              </h2>
              <p>Listed only where the project input was enough to judge. Update Project Input and re-assess to check the rest.</p>
              {missing > 0 && <p className="rule-note">Every item is also on the PM Actions list on the Dashboard.</p>}
            </>
          ) : (
            <>
              <h2>
                {FAIL_HEADLINE[category](missing)} · {rows.length} checks
              </h2>
              {score && (
                <p>
                  {score.passed} {PASS_LABEL[category].toLowerCase()} or resolved · {score.notApplicable} not applicable
                </p>
              )}
              <p>Listed only where the project input was enough to judge. Update Project Input and re-assess to check the rest.</p>
            </>
          )}
        </div>
        {settled.length > 0 && (
          <button className="link-button" onClick={() => setShowSettled(!showSettled)}>
            {showSettled ? 'Hide' : 'Show'} {settled.length} settled
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="program-empty">{empty}</div>
      ) : (
        attention.length === 0 && <div className="program-empty">Everything found missing here has been resolved.</div>
      )}

      {sections.map((section) => {
        const visible = actionable ? section.rows : section.rows.filter((row) => showSettled || needsAttention(row));
        if (section.title && visible.length === 0) return null;
        return (
          <div className="rule-section" key={section.title ?? 'all'}>
            {section.title && (
              <div className="rule-section-head">
                <strong>{section.title}</strong>
                <span>{section.note}</span>
              </div>
            )}
            <ul className="rule-list">
              {visible.map((row) => (
                <RuleRowItem key={row.ruleId} row={row} open={openRule === row.ruleId} onToggle={onToggle} />
              ))}
            </ul>
          </div>
        );
      })}
    </article>
  );
}

/**
 * The three stages a missing document moves through in Planning Documents. GENERATING is still
 * "not started" — nothing exists to review yet — and a superseded row is back in review.
 */
function documentStage(status: DocumentStatus | null): { key: string; label: string } {
  if (status === 'APPROVED') return { key: 'approved', label: 'Approved' };
  if (status === 'PM_REVIEW' || status === 'SUPERSEDED') return { key: 'review', label: 'PM review' };
  return { key: 'not-started', label: 'Not started' };
}

function RuleRowItem({
  row,
  open,
  onToggle,
}: {
  row: RuleRow;
  open: boolean;
  onToggle: (ruleId: string | null) => void;
}) {
  const missing = row.status === 'FAIL';
  const actionable = row.category === 'MISSING_INFORMATION' || row.category === 'MISSING_DOCUMENT';
  const tone = row.resolution ? 'resolved' : row.status.toLowerCase();
  /**
   * The one tag Missing Documents keeps: where the document is in Planning Documents — Not started,
   * PM review (generated, not yet confirmed) or Approved — plus Out of date when a plan change
   * flagged it. Severity and a "Missing" status tag are gone from both missing tabs — every row
   * there is missing, and the severity is what orders the list and the PM Actions, not a label the
   * PM needs to read on each row.
   */
  const stage = row.category === 'MISSING_DOCUMENT' && row.targetDocument ? documentStage(row.targetDocumentStatus) : null;

  return (
    <li className={`rule-row status-${tone} severity-${row.severity.toLowerCase()}`}>
      <button className="rule-main" onClick={() => onToggle(open ? null : row.ruleId)} aria-expanded={open}>
        <span className="rule-id">{row.ruleId}</span>
        <span className="rule-body">
          <strong>{actionable || needsAttention(row) ? row.message : row.name}</strong>
          <span className="rule-finding">{row.finding}</span>
          {row.appliesWhen && <span className="rule-condition">Only when: {row.appliesWhen}</span>}
        </span>
        <span className="rule-meta">
          {actionable ? (
            stage && (
              <>
                <span className={`status-pill doc-stage-${stage.key}`}>{stage.label}</span>
                {row.targetDocumentStale && (
                  <span className="status-pill doc-stage-stale" title={row.targetDocumentStale}>
                    Out of date after a plan change
                  </span>
                )}
              </>
            )
          ) : (
            <>
              <span className={`sev-pill sev-${row.severity.toLowerCase()}`}>{row.severity}</span>
              <span className={`status-pill status-${tone}`}>{statusLabel(row)}</span>
            </>
          )}
        </span>
      </button>

      {/*
        What to do about it, always visible rather than behind the expand: a missing item without
        its fix is a complaint, not a planning gap. It names the document the content belongs in,
        which is the same document the PM action for this rule opens.
      */}
      {missing && (
        <div className="rule-fix">
          <span className="rule-fix-where">
            {row.targetDocument ? `Add to ${row.targetDocument}` : actionable ? 'Provide on Project Input' : 'What to do'}
          </span>
          <p>{row.action ?? row.recommendedAction}</p>
        </div>
      )}

      {row.resolution && (
        <div className="rule-resolved">
          <span>✓</span>
          <p>
            {row.resolution.detail}
            {row.resolution.at && <em> · {new Date(row.resolution.at).toLocaleDateString()}</em>}
          </p>
        </div>
      )}

      {open && (row.applicability || row.evidence.length > 0) && (
        <div className="rule-detail">
          {row.applicability && (
            <p className="rule-applies">
              <b>{row.status === 'NOT_APPLICABLE' ? 'Why it does not apply:' : 'Why it applies:'}</b> {row.applicability}
            </p>
          )}
          {/*
            Both languages, for the same reason governance evidence keeps both: a translation
            cannot be searched for in the Korean PDF it came from, and "which document said this"
            is the first question a reviewer asks.
          */}
          {row.evidence.map((item, index) => (
            <div className="finding-evidence" key={index}>
              <span>{item.english}</span>
              {item.original && <q className="evidence-original">{item.original}</q>}
              {item.source && <cite className="evidence-source">{item.source}</cite>}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Methodology fit — a recommendation score, never a PASS/FAIL check
// ---------------------------------------------------------------------------

/**
 * Below this, the material does not support naming a model. The methodology guidance is explicit:
 * returning "Agile 82%" for a project with no contract type, no requirement stability and no stated
 * customer engagement model is a confident answer built on nothing, and a PM will act on it.
 */
const MIN_RELIABLE_FIT = 55;

function MethodologyFitTab({
  approaches,
  chosen,
  pmChose,
  onSelect,
  lockClass,
  lockedProps,
}: {
  approaches: ScoredApproach[];
  chosen?: ScoredApproach;
  pmChose: boolean;
  onSelect: (approach: Approach) => void;
  lockClass: string;
  lockedProps: Record<string, unknown>;
}) {
  if (!chosen) {
    return (
      <article className="panel">
        <div className="program-empty">
          No methodology has been scored yet. Run <b>✦ Analyze planning needs</b> on Project Input.
        </div>
      </article>
    );
  }

  const unreliable = chosen.score < MIN_RELIABLE_FIT;

  return (
    <div className="review-split">
      <article className="panel advisory-panel">
        <div className="panel-head">
          <div>
            <h2>Methodology fit</h2>
            <p>A suitability score from the documents — not how confident the model is</p>
          </div>
        </div>

        {unreliable && (
          <div className="fit-warning">
            <strong>Insufficient information to make a reliable methodology recommendation.</strong>
            <span>
              The highest-scoring model reaches only {chosen.score}%. Add the contract, the requirement baseline and the
              customer engagement model, then assess again.
            </span>
          </div>
        )}

        <div className={`advisory-card${lockClass}`}>
          <span className="advisory-letter">{titleCase(chosen.approach)[0]}</span>
          <div>
            <small>{pmChose ? 'YOUR CHOICE' : unreliable ? 'BEST OF A WEAK SET' : 'RECOMMENDED'}</small>
            <h3>{titleCase(chosen.approach)}</h3>
          </div>
          <strong>{chosen.score}%</strong>
        </div>

        {!pmChose && approaches.length > 1 && (
          <div className="advisory-switch">
            <span>Also scored:</span>
            {approaches.map((entry) => (
              <button
                key={entry.approach}
                className={`${entry.approach === chosen.approach ? 'active' : ''}${lockClass}`}
                {...lockedProps}
                onClick={() => onSelect(entry.approach)}
              >
                {titleCase(entry.approach)} <b>{entry.score}%</b>
              </button>
            ))}
          </div>
        )}

        <h3>Key reasons</h3>
        <ul>
          {chosen.reasons.map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
          {!chosen.reasons.length && <li>No reasons recorded.</li>}
        </ul>

        {chosen.evidence.length > 0 && (
          <>
            <h3>Supporting evidence</h3>
            <ul className="evidence-list">
              {chosen.evidence.map((item, index) => (
                <li key={index}>
                  <span className="evidence-english">{item.english}</span>
                  {item.original && <q className="evidence-original">{item.original}</q>}
                  {item.source && <cite className="evidence-source">{item.source}</cite>}
                </li>
              ))}
            </ul>
          </>
        )}
      </article>

      <article className="panel">
        <div className="panel-head">
          <div>
            <h2>Nine criteria</h2>
            <p>Each scored 0–100 at an equal 11.1% weight</p>
          </div>
        </div>
        {chosen.criteria.length === 0 ? (
          <div className="program-empty">No breakdown was recorded for this model.</div>
        ) : (
          <div className="criteria-bars">
            {chosen.criteria.map((criterion, index) => (
              <div key={index} title={criterion.note}>
                <span>{criterion.name}</span>
                <div>
                  <i style={{ width: `${Math.max(0, Math.min(100, criterion.score))}%` }} />
                </div>
                <b>{criterion.score}</b>
              </div>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}

const titleCase = (value: string) =>
  value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
