/**
 * Stage 1 of input extraction: map document text onto SELECT options without calling a model.
 *
 * This only ever catches the easy case — the document happens to contain an option's own wording.
 * It is deliberately conservative, because a wrong deterministic hit would stop the LLM stage from
 * ever looking at that field. Everything it declines is handed to the model in stage 2.
 *
 * Free-text, date and number fields are not attempted here at all: there is nothing to match
 * against, so they always go to the model.
 */

export interface MatchableField {
  fieldKey: string;
  options: string[];
}

/** Lower-cases, unifies dash variants and collapses whitespace so wording differences don't matter. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[—–−]/g, '-')
    .replace(/[×✕]/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generic one-word options ("High", "Medium", "Low", "2 days") appear in almost any document by
 * accident, so matching them literally produces confident nonsense. Only multi-word, reasonably
 * long options are distinctive enough to trust without the model's judgement.
 */
function isDistinctive(option: string): boolean {
  return option.includes(' ') && option.length >= 7;
}

export function matchOptionsInText(text: string, fields: MatchableField[]): { fieldKey: string; value: string }[] {
  const haystack = normalize(text);
  if (!haystack) return [];

  const matches: { fieldKey: string; value: string }[] = [];
  for (const field of fields) {
    const hits = field.options.filter((option) => isDistinctive(option) && haystack.includes(normalize(option)));
    // Exactly one hit, or it is not a decision this stage is entitled to make.
    if (hits.length === 1) matches.push({ fieldKey: field.fieldKey, value: hits[0] });
  }
  return matches;
}
