import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rulesApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
import type { Approach } from '../../api/types';
import type { WorkspaceView } from '../WorkspacePage';

const LETTER_CLASS: Record<string, string> = {
  WATERFALL: 'predictive',
  STAGE_GATE: 'predictive',
  SCRUM: 'adaptive',
  KANBAN: 'adaptive',
  HYBRID: 'hybrid',
  ITERATIVE: 'hybrid',
};

const letterClass = (approach: Approach) => LETTER_CLASS[approach] ?? 'hybrid';

export function ApproachView({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['approach', projectId],
    queryFn: () => rulesApi.approach(projectId),
  });

  const [selected, setSelected] = useState<Approach | null>(null);
  const [modal, setModal] = useState<null | 'confirm' | 'override'>(null);
  const [rationale, setRationale] = useState('');

  /**
   * A reader reads this screen and nothing more — the selection included. Picking a different model
   * is the first half of deciding one, so offering it and then refusing the confirm would be the
   * worse half of both.
   */
  const { canWrite, guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);

  useEffect(() => {
    if (data && !selected) {
      setSelected(data.decision?.approach ?? data.evaluation?.recommendedApproach ?? data.options[0]?.approach ?? null);
    }
  }, [data, selected]);

  const evaluate = useMutation({
    mutationFn: () => rulesApi.evaluate(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approach', projectId] });
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      notify({ title: 'AI recommendation ready', detail: 'Governance model options and document pack refreshed.' });
    },
    onError: (error) => notify({ title: 'Recommendation failed', detail: (error as Error).message }),
  });

  const decide = useMutation({
    mutationFn: (body: { approach: Approach; outcome: 'CONFIRMED' | 'OVERRIDDEN'; rationale?: string }) =>
      rulesApi.decide(projectId, body),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['approach', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['studio', projectId] }),
      ]);
      setModal(null);
      setRationale('');
      notify({
        title: `${titleCase(variables.approach)} governance model ${variables.outcome === 'CONFIRMED' ? 'confirmed' : 'overridden'}`,
        detail: 'The agent can now generate only the outputs required for this project.',
      });
      setTimeout(() => onNavigate('studio'), 350);
    },
    onError: (error) => notify({ title: 'Decision not saved', detail: (error as Error).message }),
  });

  if (isLoading || !data) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading the governance-model recommendation…
        </div>
      </section>
    );
  }

  if (!data.evaluation) {
    return (
      <section className="view active">
        <div className="page-head compact">
          <div>
            <p>PLANNING FLOW 2 · GOVERNANCE MODEL</p>
            <h1>No AI recommendation yet.</h1>
            <span>Verify the project input first, then ask the AI to recommend a governance model.</span>
          </div>
        </div>
        <article className="panel">
          <div className="program-empty">
            The AI needs verified input signals (and, optionally, an uploaded project description document) before
            it can recommend a governance model.
          </div>
          <div className="modal-actions">
            <button className="secondary" onClick={() => onNavigate('input')}>
              Go to project input
            </button>
            <button
              className={`primary${lockClass}`}
              {...lockedProps}
              onClick={guard(() => evaluate.mutate())}
              disabled={canWrite && evaluate.isPending}
            >
              {evaluate.isPending ? 'Asking the AI…' : 'Get AI recommendation'}
            </button>
          </div>
        </article>
      </section>
    );
  }

  const chosen = data.options.find((option) => option.approach === selected) ?? data.options[0];
  const pack = data.decision?.documentPack ?? chosen.pack;

  /**
   * Clicking a card only changes what this screen is *showing*. Nothing reaches the server until
   * the PM confirms, and the card's own "✓ Selected" badge read exactly like a saved decision —
   * which is how a re-pick could be made, the screen left, and the old model still be in force
   * everywhere. These two flags drive every label that has to tell the difference.
   */
  const isCurrent = (approach: string) => data.decision?.approach === approach;
  const unsavedChange = Boolean(data.decision) && chosen.approach !== data.decision?.approach;

  /** A recommendation newer than the decision is a decision waiting to be made, so say so. */
  const newerRecommendation =
    data.decision &&
    data.evaluation.createdAt > data.decision.decidedAt &&
    data.evaluation.recommendedApproach !== data.decision.approach
      ? data.evaluation.recommendedApproach
      : null;

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PLANNING FLOW 2 · GOVERNANCE MODEL</p>
          <h1>Review the recommended governance model.</h1>
          <span>
            The AI reads verified inputs and the project description document to select a governance model, its
            rigor and the planning outputs. PM can confirm or override every recommendation.
          </span>
        </div>
        <div className="decision-status">
          <span>AI confidence</span>
          <strong>{data.evaluation.confidence}%</strong>
        </div>
      </div>

      {/* The AI call silently falls back to a keyword heuristic on any error. Say so, rather than
          letting a mock result pass for a real recommendation. */}
      {data.evaluation.aiProvider === 'mock' && (
        <div className="mock-warning">
          <strong>⚠ This recommendation was not produced by the AI.</strong>
          <span>
            The model could not be reached, so a keyword heuristic scored it instead. It reads English wording only and
            ignores the meaning of the document. Check <code>AI_PROVIDER</code>, <code>ANTHROPIC_API_KEY</code> and{' '}
            <code>ANTHROPIC_MODEL</code> on the server, then run the recommendation again.
          </span>
        </div>
      )}

      {/*
        A re-run recommendation is not a decision. Without this the screen opens on the old decided
        model with no sign that the AI has since said something different, which reads as "the
        re-run did nothing".
      */}
      {newerRecommendation && (
        <div className="mock-warning newer-recommendation">
          <strong>
            A newer AI recommendation ({titleCase(newerRecommendation)}) has not been decided.
          </strong>
          <span>
            This project still runs on <b>{titleCase(data.decision!.approach)}</b>, confirmed{' '}
            {new Date(data.decision!.decidedAt).toLocaleDateString()}. Pick a model below and confirm it to
            change that — until you do, the document pack and the dashboard keep showing{' '}
            {titleCase(data.decision!.approach)}.
          </span>
        </div>
      )}

      <div className="rule-flow-explainer">
        <div>
          <span>1</span>
          <p>
            <b>Project signals</b>
            <small>Verified inputs + the uploaded project description document</small>
          </p>
        </div>
        <i>→</i>
        <div>
          <span>2</span>
          <p>
            <b>AI recommendation</b>
            <small>Confidence score, reasons and evidence</small>
          </p>
        </div>
        <i>→</i>
        <div>
          <span>3</span>
          <p>
            <b>Tailored governance model</b>
            <small>Rigor, controls and required outputs</small>
          </p>
        </div>
        <i>→</i>
        <div className="pm-gate">
          <span>4</span>
          <p>
            <b>PM decision gate</b>
            <small>Confirm, adjust or override with reason</small>
          </p>
        </div>
      </div>

      <div className="approach-grid governance-grid">
        {data.options.map((option) => (
          <article
            key={option.approach}
            className={`approach-option${selected === option.approach ? ' selected' : ''}${lockClass}`}
            {...lockedProps}
            onClick={guard(() => setSelected(option.approach))}
          >
            {option.recommended && <div className="recommended-ribbon">RECOMMENDED</div>}
            <div className="approach-top">
              <span className={`approach-letter ${letterClass(option.approach)}`}>{option.title[0]}</span>
              <div>
                <h2>{option.title}</h2>
                <small>{option.tagline}</small>
              </div>
              <strong>{option.score}%</strong>
            </div>
            <p>{option.summary}</p>
            {/*
              Three distinct states, because two of them used to share the word "Selected":
              the project's actual governance model, a pick that has not been confirmed, and the
              rest.
            */}
            <button className={selected === option.approach && !isCurrent(option.approach) ? 'pending-pick' : undefined}>
              {isCurrent(option.approach)
                ? selected === option.approach
                  ? '✓ Current model'
                  : 'Current model'
                : selected === option.approach
                  ? '● Picked — not saved yet'
                  : 'Select instead'}
            </button>
          </article>
        ))}
      </div>

      <div className="approach-detail-grid">
        <article className="panel insight-card">
          <div className="panel-head">
            <div>
              <h2>Why {titleCase(data.evaluation.recommendedApproach)} was recommended</h2>
              <p>{data.evaluation.rationale}</p>
            </div>
            <span className="rule-version">{data.evaluation.confidenceLevel} confidence</span>
          </div>
          <h3>Key reasons</h3>
          <ul>
            {data.evaluation.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
            {data.evaluation.reasons.length === 0 && <li>No reasons recorded.</li>}
          </ul>
          {data.evaluation.evidence.length > 0 && (
            <>
              <h3>Supporting evidence</h3>
              {/*
                English first, because that is the language of this application; the source's own
                sentence underneath, because that is the one a PM can find in the uploaded file —
                a translation cannot be searched for in a Korean document. The file name is
                deliberately loud: evidence whose provenance is unstated is not evidence.
              */}
              <ul className="evidence-list">
                {data.evaluation.evidence.map((item, index) => (
                  <li key={`${item.english}-${index}`}>
                    <span className="evidence-english">{item.english}</span>
                    {item.original && <q className="evidence-original">{item.original}</q>}
                    {item.source && <cite className="evidence-source">{item.source}</cite>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {data.evaluation.risks.length > 0 && (
            <>
              <h3>Risks &amp; limitations</h3>
              <ul>
                {data.evaluation.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </>
          )}
          <button
            className={`secondary full${lockClass}`}
            {...lockedProps}
            onClick={guard(() => evaluate.mutate())}
            disabled={canWrite && evaluate.isPending}
          >
            {evaluate.isPending ? 'Re-asking the AI…' : 'Re-run AI recommendation'}
          </button>
        </article>

        <aside className="panel operating-model">
          <span className="ai-label">PROPOSED OPERATING MODEL</span>
          <h2>
            {chosen.title} · {chosen.operatingModel.rigor}
          </h2>
          {Object.entries(chosen.operatingModel.controls).map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </aside>
      </div>

      <article className="panel document-rule-panel">
        <div className="panel-head">
          <div>
            <h2>Planning outputs for {chosen.title}</h2>
            <p>Required for every project regardless of governance model; conditional documents depend on project signals</p>
          </div>
          <div className="document-count">
            <strong>{pack.required.length}</strong>
            <span>required</span>
            <strong>{pack.conditional.length}</strong>
            <span>conditional</span>
          </div>
        </div>
        <div className="doc-rule-chips">
          {pack.required.map((item) => (
            <span className="required-rule" key={item}>
              ✓ {item}
              <small>Required</small>
            </span>
          ))}
          {pack.conditional.map((item) => (
            <span className="conditional-rule" key={item}>
              ◇ {item}
              <small>Conditional</small>
            </span>
          ))}
        </div>
      </article>

      <div className={`sticky-action${unsavedChange ? ' unsaved' : ''}`}>
        <div>
          <span>✦</span>
          <p>
            {unsavedChange ? (
              <>
                {/*
                  The case that made this a bug report: a different card was picked, the screen was
                  left, and the project was still running on the old model — because picking is not
                  deciding and nothing on screen said so.
                */}
                <strong>
                  You picked {chosen.title}, but this project still runs on{' '}
                  {titleCase(data.decision!.approach)}.
                </strong>
                <br />
                Nothing changes until you confirm — leaving this screen now keeps{' '}
                {titleCase(data.decision!.approach)}.
              </>
            ) : data.decision ? (
              <>
                <strong>
                  {titleCase(data.decision.approach)} was {data.decision.outcome.toLowerCase()} by{' '}
                  {data.decision.decidedBy.name}.
                </strong>
                <br />
                Confirming again creates a new version of the generation contract.
              </>
            ) : (
              <>
                <strong>The AI recommendation is ready for PM decision.</strong>
                <br />
                Confirming it locks the generation contract and document list.
              </>
            )}
          </p>
        </div>
        {/* Locked rather than `disabled`: a disabled button cannot tell the reader why. */}
        <button className={`secondary${lockClass}`} {...lockedProps} onClick={guard(() => setModal('override'))}>
          Override with reason
        </button>
        {/* Naming the model on the button itself means the click can never mean something else. */}
        <button className={`primary${lockClass}`} {...lockedProps} onClick={guard(() => setModal('confirm'))}>
          Confirm {chosen.title} &amp; generate
        </button>
      </div>

      <Backdrop open={modal !== null} onClose={() => setModal(null)} />
      <ModalShell open={modal !== null} className="decision-modal">
        <div className="modal-head">
          <span className="agent-orb">✦</span>
          <div>
            <small>PM DECISION REQUIRED</small>
            <h2>
              {modal === 'override'
                ? 'Override recommendation with PM rationale'
                : `Confirm ${chosen.title} governance model`}
            </h2>
          </div>
          <button className="close-modal" onClick={() => setModal(null)}>
            ×
          </button>
        </div>
        <div className="rationale">
          <h3>What this confirmation means</h3>
          <p>
            The selected governance model becomes the generation contract for governance controls, workflow and the
            planning document pack. Any later change is versioned.
          </p>
          <div>
            <span>Basis</span>
            <b>{data.evaluation.reasons.length} recommendation reasons</b>
            <b>{pack.required.length + pack.conditional.length} planned outputs</b>
          </div>
        </div>
        <label>
          PM rationale{modal === 'override' ? ' *' : ''}
          <textarea
            placeholder="Add the reason for confirming or overriding…"
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={decide.isPending || (modal === 'override' && !rationale.trim())}
            onClick={() =>
              decide.mutate({
                approach: chosen.approach,
                outcome: modal === 'override' ? 'OVERRIDDEN' : 'CONFIRMED',
                rationale: rationale.trim() || undefined,
              })
            }
          >
            {decide.isPending ? 'Saving decision…' : 'Confirm & generate'}
          </button>
        </div>
      </ModalShell>
    </section>
  );
}

const titleCase = (value: string) =>
  value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
