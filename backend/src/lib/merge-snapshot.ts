import type {
  AnalysisFinding,
  OverviewSection,
  PlanChangeImpact,
  PlanningGap,
  ScoredApproach,
} from '../modules/ai/provider';

/**
 * Applies a plan-change delta to the analysis snapshot it was measured against.
 *
 * This is the half of Change plan mode that is **not** a model call, and keeping it that way is the
 * point. The model is asked only for what moved — a few hundred output tokens instead of the eleven
 * thousand a full re-analysis writes, most of which would be a restatement of what did not change.
 * Reassembling the whole picture from the previous snapshot plus that delta is deterministic work,
 * and deterministic work should not be paid for per token or be able to hallucinate.
 *
 * It is a pure function for the same reason `computeInputReadiness` is: a merge that silently drops
 * a gap or duplicates an overview block produces a snapshot that looks perfectly normal everywhere
 * downstream. There is nothing to notice at runtime, so it is tested instead.
 */
export interface MergedSnapshot {
  overview: OverviewSection[];
  gaps: PlanningGap[];
  findings: AnalysisFinding[];
  approaches: ScoredApproach[];
  summary: string;
}

export interface PreviousSnapshot {
  overview: OverviewSection[];
  gaps: PlanningGap[];
  findings: AnalysisFinding[];
  approaches: ScoredApproach[];
  summary: string;
}

export function mergeSnapshot(previous: PreviousSnapshot, impact: PlanChangeImpact): MergedSnapshot {
  /**
   * Overview blocks are replaced **in place** by `key`, never appended and re-sorted. The order is
   * the reading order the prompt fixes (scope, requirements, schedule…), and a block that jumped to
   * the bottom because it changed would make the panel reshuffle itself on every change — the PM
   * would lose their place in the one view that is meant to be stable.
   */
  const changedByKey = new Map(impact.changedOverview.map((block) => [block.key, block]));
  const overview: OverviewSection[] = previous.overview.map((block) => {
    const change = changedByKey.get(block.key);
    if (!change) return block;
    changedByKey.delete(block.key);
    return { key: block.key, label: change.label || block.label, summary: change.summary, points: change.points };
  });
  // A changed block whose key is not in the previous overview is a block the earlier analysis never
  // had — the change revealed something new about the project. Append rather than discard.
  for (const block of changedByKey.values()) {
    overview.push({ key: block.key, label: block.label, summary: block.summary, points: block.points });
  }

  /**
   * Gaps close by **position**, one-based, because that is how the prompt numbered them. Matching on
   * the title instead would fail on exactly the gaps whose wording the model paraphrased, and would
   * fail silently — the gap would simply stay open with nobody able to say why.
   */
  const closed = new Set(impact.closedGaps);
  const gaps = previous.gaps.filter((_gap, index) => !closed.has(index + 1)).concat(impact.newGaps);

  // Findings accumulate: an earlier contradiction is not resolved by a later change unless that
  // change actually resolved it, and the model is not asked to adjudicate old ones.
  const findings = previous.findings.concat(impact.newFindings);

  /**
   * The approach in force keeps its identity and its per-criterion breakdown; only the score and a
   * note move. Re-deciding the governance model is the PM's gate (`ApproachDecision`) and a merge
   * must never walk through it — `suggested` is carried to the screen as advice and nothing else.
   */
  const [primary, ...rest] = previous.approaches;
  const approaches = primary
    ? [
        {
          ...primary,
          score: impact.approach.score || primary.score,
          reasons: impact.approach.note ? [impact.approach.note, ...primary.reasons] : primary.reasons,
        },
        ...rest,
      ]
    : previous.approaches;

  return {
    overview,
    gaps,
    findings,
    approaches,
    summary: impact.summary || previous.summary,
  };
}
