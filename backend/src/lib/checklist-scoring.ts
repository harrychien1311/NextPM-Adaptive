/**
 * Scoring a project against its customer's checklist.
 *
 * Two ideas carry the whole design:
 *
 * 1. **"Not looked at" and "looked at and missing" must never read the same.** `UNKNOWN` is not
 *    `NOT_MET`. A PM who sees 40% has to be able to tell whether the other 60% is work to do or
 *    work nobody has checked yet, so the score is reported alongside how much has been assessed.
 * 2. **A question that does not apply must not drag the score down.** The AGS checklist scopes
 *    items out explicitly (범위 외), and a PM can rule others out. `NOT_APPLICABLE` leaves the
 *    denominator, it does not count as a failure.
 *
 * The deterministic pass below is deliberately small. It only claims a match when a checklist item
 * names a project input field almost verbatim, because a wrong `MET` is worse than an honest
 * `UNKNOWN`: it tells the PM a customer requirement is covered when it is not. Everything it
 * cannot prove is left for the model, and whatever the model cannot prove is left for the PM.
 */

import { ChecklistStatus } from '@prisma/client';

export interface ScorableItem {
  status: ChecklistStatus;
}

export interface ChecklistScore {
  /** 0-100 over the applicable items. `PARTIAL` counts half. */
  score: number;
  /** Items that count towards the score — everything except NOT_APPLICABLE. */
  applicable: number;
  /** Of the applicable items, how many have actually been looked at. */
  assessed: number;
  met: number;
  partial: number;
  notMet: number;
  unknown: number;
  notApplicable: number;
  /** What share of the applicable items has been assessed at all — the score's own confidence. */
  coverage: number;
}

export function computeChecklistScore(items: ScorableItem[]): ChecklistScore {
  const count = (status: ChecklistStatus) => items.filter((item) => item.status === status).length;

  const met = count(ChecklistStatus.MET);
  const partial = count(ChecklistStatus.PARTIAL);
  const notMet = count(ChecklistStatus.NOT_MET);
  const unknown = count(ChecklistStatus.UNKNOWN);
  const notApplicable = count(ChecklistStatus.NOT_APPLICABLE);

  const applicable = met + partial + notMet + unknown;
  const assessed = met + partial + notMet;

  return {
    score: applicable ? Math.round(((met + partial * 0.5) / applicable) * 100) : 0,
    applicable,
    assessed,
    met,
    partial,
    notMet,
    unknown,
    notApplicable,
    coverage: applicable ? Math.round((assessed / applicable) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// The deterministic pass
// ---------------------------------------------------------------------------

/** Case, spacing and punctuation are noise when comparing a label to a question. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .trim();
}

/**
 * A label has to be distinctive before a containment match means anything. "Type" or "Scope"
 * appear inside half of any checklist; "business objective" does not.
 */
function isDistinctive(label: string): boolean {
  const normalized = normalize(label);
  return normalized.length >= 10 && normalized.includes(' ');
}

export interface DeterministicInput {
  label: string;
  value: string;
  verified: boolean;
}

export interface DeterministicMatch {
  status: ChecklistStatus;
  evidence: string;
  note: string;
}

/**
 * Answers a checklist item from the project's own verified inputs, when the item names one of
 * them almost verbatim — LGCNS's checklist literally asks "프로젝트 목표 Project goals", and the
 * project has a "Project goals" input. That is a fact, not an inference, so it needs no model.
 *
 * Returns null far more often than not. That is the point: this pass exists to make the model's
 * job smaller and cheaper, not to produce a score on its own.
 */
export function matchInputEvidence(
  item: { text: string; guidance: string | null },
  inputs: DeterministicInput[],
): DeterministicMatch | null {
  const haystack = normalize(`${item.text} ${item.guidance ?? ''}`);
  if (!haystack) return null;

  // Longest label first: "project goals" should win over a shorter label that also fits.
  const candidates = inputs
    .filter((input) => input.value.trim() && isDistinctive(input.label))
    .sort((a, b) => normalize(b.label).length - normalize(a.label).length);

  for (const input of candidates) {
    if (!haystack.includes(normalize(input.label))) continue;
    const excerpt = input.value.length > 160 ? `${input.value.slice(0, 157)}…` : input.value;
    return input.verified
      ? {
          status: ChecklistStatus.MET,
          evidence: `Verified project input — ${input.label}: ${excerpt}`,
          note: 'Matched deterministically: the checklist item names this input field.',
        }
      : {
          status: ChecklistStatus.PARTIAL,
          evidence: `Project input (not yet PM-verified) — ${input.label}: ${excerpt}`,
          note: 'The input answers this, but the PM has not verified it, so it is not yet a fact.',
        };
  }
  return null;
}

/**
 * The customer's own document can put an item out of scope. The AGS checklist says so in prose
 * (범위 외 / "out of scope"), and a source cell reading "N/A" means the same thing.
 */
export function sourceMarksNotApplicable(item: {
  section: string | null;
  text: string;
  guidance: string | null;
  expected: string | null;
}): boolean {
  const expected = (item.expected ?? '').trim().toLowerCase();
  if (expected === 'n/a' || expected === 'na') return true;
  return /범위\s*외|out of scope|not applicable/i.test(`${item.section ?? ''} ${item.text} ${item.guidance ?? ''}`);
}
