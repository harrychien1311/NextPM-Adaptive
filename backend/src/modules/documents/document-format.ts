/**
 * Presentation constants and helpers shared by every document export — the `.docx` writer, the
 * `.xlsx` writer and the dashboard `.html`. They live here rather than in `documents.service`
 * so the spreadsheet writer can use them without importing the service back (a cycle).
 */

import type { DocumentGap } from '../ai/provider';
import { isTableDocument } from '../../data/table-documents';

export { isTableDocument } from '../../data/table-documents';

/** Brand palette for exports — same navy/blue as the app's design system. */
export const DOC_COLORS = {
  navy: '10243D',
  blue: '1F5FA9',
  rule: 'C9D6E6',
  headerBg: '10243D',
  zebra: 'F4F7FB',
  gapText: 'B26A00',
  gapBg: 'FFF1D6',
  muted: '6B7C93',
} as const;

/** Unanswered blanks the model left behind. Global — do not call `.test()` on it (lastIndex is stateful). */
export const GAP_PATTERN = /\{\{gap:\d+\}\}/g;

/** What an unanswered `{{gap:N}}` looks like in an exported file. Never the raw token. */
export const GAP_LABEL = '[ answer needed ]';

/** Normalises the JSON column, which held plain strings before gaps existed. */
export function readGaps(value: unknown): DocumentGap[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index): DocumentGap | null => {
      if (typeof entry === 'string') return { token: `{{gap:${index + 1}}}`, question: entry, answer: null };
      if (entry && typeof entry === 'object' && 'question' in entry) {
        const gap = entry as DocumentGap;
        // `ruleId` kept: it ties a question to the Missing Information finding it asks about, and
        // dropping it on read would quietly break that link the first time the gaps are re-saved.
        return {
          token: gap.token,
          question: gap.question,
          answer: gap.answer ?? null,
          ruleId: gap.ruleId ?? null,
          // Kept for the same reason: a re-save must not strip the AI's suggestion off a question.
          suggestion: gap.suggestion ?? null,
          suggestionBasis: gap.suggestionBasis ?? null,
          // A question about a person is settled from the start — it never gets a suggestion, so
          // the Studio must not offer to ask for one.
          suggested: Boolean(gap.suggested) || isPersonQuestion(gap.question),
        };
      }
      return null;
    })
    .filter((gap): gap is DocumentGap => gap !== null);
}

/**
 * A question whose answer is a person — a name, an owner, a sponsor, a contact. The AI never gets to
 * suggest one of those: a plausible name offered as a suggestion is still an invented name, and it
 * is exactly the kind a busy PM accepts without checking. Checked here in code rather than trusted
 * to the prompt; it errs towards dropping, since a missing suggestion costs the PM nothing.
 */
const PERSON_QUESTION =
  /\b(who|whom|whose)\b|\bnames?\b|\b(sponsors?|owners?|contacts?|approvers?|signator(y|ies)|assignees?|persons?|people|individuals?|e-?mail)\b/i;

export function isPersonQuestion(question: string): boolean {
  return PERSON_QUESTION.test(question);
}

const MAX_SUGGESTION_CHARS = 300;
const MAX_BASIS_CHARS = 200;

/**
 * Cleans the suggestions the model put on its gaps: trimmed, capped, dropped on any question about a
 * person, and each gap marked as asked (`suggested`) when a real model produced it — so the Studio
 * does not offer to ask again for a suggestion it already declined to make.
 */
export function withSafeSuggestions(gaps: DocumentGap[], askedModel: boolean): DocumentGap[] {
  return gaps.map((gap) => {
    const suggestion = gap.suggestion?.trim().slice(0, MAX_SUGGESTION_CHARS) || null;
    const allowed = suggestion && !isPersonQuestion(gap.question);
    return {
      ...gap,
      suggestion: allowed ? suggestion : null,
      suggestionBasis: allowed ? gap.suggestionBasis?.trim().slice(0, MAX_BASIS_CHARS) || null : null,
      suggested: askedModel || Boolean(gap.suggested),
    };
  });
}

export function slugForFile(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * Which real file a planning document exports as, decided from the catalog name so the UI can
 * label the button before anything is generated.
 *
 * - A **RACI** document is a matrix — a grid of activities against roles — so it is a spreadsheet
 *   the PM can sort, filter and paste into their own tracker.
 * - A **kickoff deck is a deck**, always. It is presented in a room, so a Word file is the wrong
 *   artefact even when the customer has no template of their own: with a template we fill theirs
 *   in place, without one we build a neutral deck carrying their logo. This must never fall back
 *   to `.docx` — that was the bug this rule exists to prevent.
 * - An **organization chart is a chart**. A reporting structure written as paragraphs is not a
 *   reporting structure, so it is drawn as one slide of boxes (`lib/pptx-orgchart.ts`) rather than
 *   described in prose.
 * - Everything else is prose and stays a Word file.
 */
export function documentExportFormat(documentName: string): 'DOCX' | 'XLSX' | 'PPTX' {
  // Register documents — a change log, an escalation path, a work breakdown. Every row is one
  // entry, and the value is in sorting and filtering the grid. See data/table-documents.ts.
  if (isTableDocument(documentName)) return 'XLSX';
  if (/raci/i.test(documentName)) return 'XLSX';
  if (/\bdeck\b|kick.?off/i.test(documentName)) return 'PPTX';
  if (/organi[sz]ation chart|org chart/i.test(documentName)) return 'PPTX';
  return 'DOCX';
}

/** True for the documents whose whole deliverable is a drawn chart — no prose belongs in them. */
export function isChartDocument(documentName: string): boolean {
  return /organi[sz]ation chart|org chart/i.test(documentName);
}

/**
 * True when the document carries no narrative at all: its deliverable is a chart or a table.
 * `generateDraft` forces `sections: []` for these, so the export, the preview and the studio
 * panel cannot disagree about whether prose exists.
 */
export function isStructureOnlyDocument(documentName: string): boolean {
  return isChartDocument(documentName) || isTableDocument(documentName);
}

/** Splits text on unanswered gap tokens: `[{text, gap}]`, where `gap` marks the blank segments. */
export function splitOnGaps(text: string): { text: string; gap: boolean }[] {
  const parts: { text: string; gap: boolean }[] = [];
  let cursor = 0;
  for (const match of text.matchAll(GAP_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: text.slice(cursor, index), gap: false });
    parts.push({ text: GAP_LABEL, gap: true });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), gap: false });
  return parts.length ? parts : [{ text, gap: false }];
}
