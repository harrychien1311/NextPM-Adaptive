import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rulesApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import type { Approach, EvidenceItem, PlanningGap, ScoredApproach } from '../../api/types';
import type { WorkspaceView } from '../WorkspacePage';

/**
 * Planning Review — everything one analysis found, on one screen.
 *
 * It replaces the old Governance Model screen, which answered a single question (which model?).
 * A PM standing in front of a new project has three: what *is* this project, how should it be run,
 * and what is still missing before it can start. Those are read from the same documents in the same
 * call, so they are shown together:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Project overview — scope, schedule, people…  │
 *   ├───────────────────────┬──────────────────────┤
 *   │ Planning gaps         │ Approach advisory    │
 *   │ + document findings   │ + the score          │
 *   └───────────────────────┴──────────────────────┘
 *
 * The advisory has two modes and they are genuinely different screens, not a flag on one. When the
 * PM had not decided, it argues a case: the top model with its reasons and quoted evidence, and up
 * to three others they can switch to. When the PM *had* decided on Project Input, there is nothing
 * to argue — it reports how well that choice fits, with reasons and no evidence, and offers no
 * alternatives, because presenting a switch for a decision already made is how a screen talks a PM
 * out of their own judgement.
 */
export function PlanningReviewView({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const { canWrite, guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);

  const { data, isLoading } = useQuery({
    queryKey: ['approach', projectId],
    queryFn: () => rulesApi.approach(projectId),
  });

  const [selected, setSelected] = useState<Approach | null>(null);
  const [modal, setModal] = useState(false);
  const [rationale, setRationale] = useState('');

  const evaluation = data?.evaluation ?? null;

  /** All the scored models, primary first — `alternatives` carries the rest of the ranking. */
  const approaches: ScoredApproach[] = evaluation
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
    : [];

  useEffect(() => {
    if (evaluation && !selected) setSelected(evaluation.recommendedApproach);
  }, [evaluation, selected]);

  const chosen = approaches.find((entry) => entry.approach === selected) ?? approaches[0];
  const pmChose = evaluation?.approachMode === 'PM_CHOSEN';

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
        detail: 'Opening the Planning Studio with the documents this project is missing.',
      });
      setTimeout(() => onNavigate('studio'), 350);
    },
    onError: (error) => notify({ title: 'Decision not saved', detail: (error as Error).message }),
  });

  if (isLoading) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading the planning review…
        </div>
      </section>
    );
  }

  if (!evaluation) {
    return (
      <section className="view active">
        <div className="page-head compact">
          <div>
            <p>PLANNING FLOW 2 · PLANNING REVIEW</p>
            <h1>Nothing has been analysed yet.</h1>
          </div>
        </div>
        <article className="panel">
          <div className="program-empty">
            Upload the project description document on Project Input and press{' '}
            <b>✦ Analyze planning needs</b>. Everything on this screen is read from those documents.
          </div>
          <div className="modal-actions">
            <button className="primary" onClick={() => onNavigate('input')}>
              Go to Project Input
            </button>
          </div>
        </article>
      </section>
    );
  }

  const gaps = evaluation.planningGaps ?? [];
  const findings = evaluation.findings ?? [];

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PLANNING FLOW 2 · PLANNING REVIEW</p>
          <h1>{pmChose ? 'How your chosen approach fits.' : 'What this project needs.'}</h1>
          <span>{evaluation.summary ?? evaluation.rationale}</span>
        </div>
        <div className="decision-status">
          <span>{pmChose ? 'Fit of your choice' : 'AI confidence'}</span>
          <strong>{chosen?.score ?? 0}%</strong>
        </div>
      </div>

      {evaluation.aiProvider === 'mock' && (
        <div className="mock-warning">
          <strong>⚠ This analysis was not produced by the AI.</strong>
          <span>
            Check <code>AI_PROVIDER</code> and <code>ANTHROPIC_API_KEY</code> on the server, then analyse again.
          </span>
        </div>
      )}

      {/* ---- top panel: what the project is ---------------------------------- */}
      <article className="panel overview-panel">
        <div className="panel-head">
          <div>
            <h2>Project overview</h2>
            <p>Read from the uploaded documents — not from what anyone typed into the form</p>
          </div>
          <span className="rule-version">{evaluation.confidenceLevel} confidence</span>
        </div>

        {evaluation.overview.length === 0 ? (
          <div className="program-empty">The documents did not support an overview. Analyse again with more of them.</div>
        ) : (
          <div className="overview-grid">
            {evaluation.overview.map((section) => (
              <article className="overview-card" key={section.key}>
                <header>
                  <span className={`domain-glyph ${OVERVIEW_TONE[section.key] ?? 'navy'}`}>
                    {OVERVIEW_GLYPH[section.key] ?? '•'}
                  </span>
                  <h3>{section.label}</h3>
                </header>
                <p>{section.summary}</p>
                <ul>
                  {section.points.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </article>

      {/* ---- the two lower panels -------------------------------------------- */}
      <div className="review-split">
        <article className="panel gap-panel">
          <div className="panel-head">
            <div>
              <h2>Planning gaps</h2>
              <p>What is still missing before this project can start</p>
            </div>
            <span className="count-pill">{gaps.length}</span>
          </div>

          {gaps.length === 0 ? (
            <div className="program-empty">Nothing missing was found — rare, and worth a second look.</div>
          ) : (
            <ul className="gap-list">
              {gaps.map((gap, index) => (
                <li key={index} className={`gap-row severity-${gap.severity.toLowerCase()}`}>
                  <span className="gap-severity">{gap.severity}</span>
                  <div>
                    <strong>{gap.title}</strong>
                    <p>{gap.why}</p>
                    {/* The tie to a catalog name is what lets the Studio show only these. */}
                    {gap.documentName && <span className="gap-doc">→ {gap.documentName}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {/*
            Kept in the same panel as the gaps, deliberately. Both answer "what stands between this
            project and a plan I trust" — one because something is absent, the other because two
            documents disagree. Splitting them into separate screens would hide the second.
          */}
          <div className="panel-head findings-head">
            <div>
              <h2>Risks &amp; limitations</h2>
              <p>Contradictions and anomalies found across the uploaded documents</p>
            </div>
            <span className="count-pill">{findings.length}</span>
          </div>

          {findings.length === 0 ? (
            <div className="program-empty">No contradictions found between the documents.</div>
          ) : (
            <ul className="finding-list">
              {findings.map((finding, index) => (
                <li key={index}>
                  <strong>{finding.title}</strong>
                  <p>{finding.detail}</p>
                  {finding.evidence.map((item, evidenceIndex) => (
                    <div className="finding-evidence" key={evidenceIndex}>
                      <span>{item.english}</span>
                      {item.original && <q className="evidence-original">{item.original}</q>}
                      {item.source && <cite className="evidence-source">{item.source}</cite>}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="panel advisory-panel">
          <div className="panel-head">
            <div>
              <h2>Approach advisory</h2>
              <p>
                {pmChose
                  ? 'How the model you chose scores against the nine criteria'
                  : 'The model this project’s evidence points to'}
              </p>
            </div>
          </div>

          {chosen && (
            <div className={`advisory-card${lockClass}`}>
              <span className="advisory-letter">{titleCase(chosen.approach)[0]}</span>
              <div>
                <small>{pmChose ? 'YOUR CHOICE' : 'RECOMMENDED'}</small>
                <h3>{titleCase(chosen.approach)}</h3>
              </div>
              <strong>{chosen.score}%</strong>
            </div>
          )}

          {/*
            Only in RECOMMENDED mode, and only when there is more than one. In PM_CHOSEN mode the
            server returns a single entry, so this renders nothing without needing a second check.
          */}
          {!pmChose && approaches.length > 1 && (
            <div className="advisory-switch">
              <span>Also scored:</span>
              {approaches.map((entry) => (
                <button
                  key={entry.approach}
                  className={`${entry.approach === chosen?.approach ? 'active' : ''}${lockClass}`}
                  {...lockedProps}
                  onClick={guard(() => setSelected(entry.approach))}
                >
                  {titleCase(entry.approach)} <b>{entry.score}%</b>
                </button>
              ))}
            </div>
          )}

          <h3>Key reasons</h3>
          <ul>
            {(chosen?.reasons ?? []).map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
            {!chosen?.reasons.length && <li>No reasons recorded.</li>}
          </ul>

          {/* Empty by design when the PM chose the model — see the note at the top of this file. */}
          {(chosen?.evidence.length ?? 0) > 0 && (
            <>
              <h3>Supporting evidence</h3>
              <ul className="evidence-list">
                {chosen!.evidence.map((item, index) => (
                  <li key={index}>
                    <span className="evidence-english">{item.english}</span>
                    {item.original && <q className="evidence-original">{item.original}</q>}
                    {item.source && <cite className="evidence-source">{item.source}</cite>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {(chosen?.criteria.length ?? 0) > 0 && (
            <>
              <h3>Score breakdown</h3>
              <div className="criteria-bars">
                {chosen!.criteria.map((criterion, index) => (
                  <div key={index} title={criterion.note}>
                    <span>{criterion.name}</span>
                    <div>
                      <i style={{ width: `${Math.max(0, Math.min(100, criterion.score))}%` }} />
                    </div>
                    <b>{criterion.score}</b>
                  </div>
                ))}
              </div>
            </>
          )}
        </article>
      </div>

      <div className="sticky-action">
        <div>
          <span>✦</span>
          <p>
            <strong>
              {data?.decision
                ? `${titleCase(data.decision.approach)} was ${data.decision.outcome.toLowerCase()} by ${data.decision.decidedBy.name}.`
                : `Confirming ${titleCase(chosen?.approach ?? '')} freezes it as this project’s governance model.`}
            </strong>
            <br />
            The Planning Studio then opens with the {gaps.length} document
            {gaps.length === 1 ? '' : 's'} this analysis says are missing, plus the kickoff deck.
          </p>
        </div>
        {/* Left of the confirm, because going back is the cheaper of the two and should not be
            the harder one to find. */}
        <button className="secondary" onClick={() => onNavigate('input')}>
          ← Back to inputs
        </button>
        <button className={`primary${lockClass}`} {...lockedProps} onClick={guard(() => setModal(true))}>
          Confirm and open Studio
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
            This becomes the generation contract for the document pack. The Studio will open on the{' '}
            {gaps.length} missing document{gaps.length === 1 ? '' : 's'} identified above.
          </p>
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

/** Icons and colours per overview block, so the panel reads as a briefing rather than a wall. */
const OVERVIEW_GLYPH: Record<string, string> = {
  scope: 'S',
  requirements: 'R',
  schedule: 'T',
  resources: 'P',
  stakeholders: 'H',
  commercial: '$',
  constraints: '!',
};

const OVERVIEW_TONE: Record<string, string> = {
  scope: 'cyan',
  requirements: 'navy',
  schedule: 'violet',
  resources: 'rose',
  stakeholders: 'orange',
  commercial: 'green-bg',
  constraints: 'red-bg',
};

const titleCase = (value: string) =>
  value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

export type { PlanningGap };
