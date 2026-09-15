/**
 * Matches a project's free-text Customer field to a `Customer` in the reference library.
 *
 * The field stays free text deliberately — a dropdown would mean nobody can start a project for a
 * new customer until someone edits a list first. The cost of that choice is that "SKAX", "SK AX",
 * "SK C&C" and "AGS" all have to land on the same customer, which is what `aliases` is for.
 *
 * An alias may be written three ways, and all three are editable in the Customer library screen —
 * adding a customer or changing how one is recognised never needs a code change:
 *
 * | Alias    | Means                                                                    |
 * | -------- | ------------------------------------------------------------------------ |
 * | `SK C&C` | this exact name, ignoring case, spacing and punctuation                   |
 * | `SK*`    | any customer name **starting with** SK — the whole SK group in one rule   |
 * | `*`      | the house default: used when nothing else matched at all                  |
 *
 * Resolution runs most-certain-first — exact, then prefix, then containment, then the default —
 * and reports which one fired, because "we know this is SK AX" and "we fell back to the house
 * template" are different facts and the PM is entitled to see which they have.
 */

export interface MatchableCustomer {
  id: string;
  key: string;
  name: string;
  aliases: string[];
}

/**
 * How the match was reached, weakest last:
 * - `exact`    — the field is one of the known spellings.
 * - `prefix`   — the field starts with a `SK*`-style rule.
 * - `partial`  — the field contains a known spelling ("Dự án cho LG CNS").
 * - `default`  — nothing matched; this is the customer holding the `*` alias.
 */
export type MatchConfidence = 'exact' | 'prefix' | 'partial' | 'default';

export interface CustomerMatch<T extends MatchableCustomer> {
  customer: T;
  confidence: MatchConfidence;
  /** The spelling or rule that matched, so the UI can explain itself. */
  matchedOn: string;
}

/** The alias that marks the house default. */
export const DEFAULT_ALIAS = '*';
/** Suffix that turns an alias into a "starts with" rule. */
export const PREFIX_SUFFIX = '*';

/** Case, spacing and punctuation are noise: "SK C&C", "sk c and c" and "SKC&C" are one name. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9가-힣]+/g, '');
}

/**
 * A short alias must match a whole word, not a fragment — otherwise "AGS" would match "AGSTAR"
 * and every customer whose name happens to contain those letters. Prefix rules are exempt:
 * `SK*` is *meant* to be short, and being a prefix is what makes it safe.
 */
const MIN_LENGTH_FOR_PARTIAL = 4;

const isDefaultAlias = (alias: string) => alias.trim() === DEFAULT_ALIAS;
const isPrefixAlias = (alias: string) => alias.trim().length > 1 && alias.trim().endsWith(PREFIX_SUFFIX);
const prefixOf = (alias: string) => alias.trim().slice(0, -1);

export function matchCustomer<T extends MatchableCustomer>(
  customerText: string | null | undefined,
  customers: T[],
): CustomerMatch<T> | null {
  const fallback = customers.find((customer) => customer.aliases.some(isDefaultAlias));
  const needle = normalize(customerText ?? '');

  // An empty Customer field is not a customer. It still gets the house default, so a project is
  // never left unbranded, but it is reported as `default` rather than as a recognised name.
  if (!needle) {
    return fallback ? { customer: fallback, confidence: 'default', matchedOn: DEFAULT_ALIAS } : null;
  }

  const candidates = customers.map((customer) => ({
    customer,
    // The key and the name are always spellings of the customer; `*` and `SK*` are rules.
    spellings: [customer.key, customer.name, ...customer.aliases.filter((a) => !isDefaultAlias(a) && !isPrefixAlias(a))]
      .filter(Boolean),
    prefixes: customer.aliases.filter(isPrefixAlias).map(prefixOf).filter(Boolean),
  }));

  // 1. The whole field is one of the known spellings.
  for (const { customer, spellings } of candidates) {
    for (const spelling of spellings) {
      if (normalize(spelling) === needle) return { customer, confidence: 'exact', matchedOn: spelling };
    }
  }

  // 2. A prefix rule: "SK*" claims the whole SK group. Longest prefix wins, so a later, more
  //    specific rule ("SKAX*") always beats a broader one ("SK*").
  const prefixHit = candidates
    .flatMap(({ customer, prefixes }) => prefixes.map((prefix) => ({ customer, prefix })))
    .filter(({ prefix }) => normalize(prefix) && needle.startsWith(normalize(prefix)))
    .sort((a, b) => normalize(b.prefix).length - normalize(a.prefix).length)[0];
  if (prefixHit) {
    return { customer: prefixHit.customer, confidence: 'prefix', matchedOn: `${prefixHit.prefix}*` };
  }

  // 3. The field contains a known spelling ("SKAX Vietnam", "Dự án cho LG CNS").
  //    Longest spelling first, so "SK C&C" is preferred over a shorter alias that also fits.
  const partial = candidates
    .flatMap(({ customer, spellings }) => spellings.map((spelling) => ({ customer, spelling })))
    .filter(({ spelling }) => normalize(spelling).length >= MIN_LENGTH_FOR_PARTIAL)
    .sort((a, b) => normalize(b.spelling).length - normalize(a.spelling).length)
    .find(({ spelling }) => needle.includes(normalize(spelling)));
  if (partial) return { customer: partial.customer, confidence: 'partial', matchedOn: partial.spelling };

  // 4. Nothing recognised it. The house default takes it, clearly labelled as such.
  return fallback ? { customer: fallback, confidence: 'default', matchedOn: DEFAULT_ALIAS } : null;
}

/**
 * Whether a match actually identified the customer, as opposed to falling back to the house
 * default. Callers that must not treat "we defaulted" as "we know" — proposing a customer to the
 * PM, or scoring a project against a customer's checklist — use this rather than a null check.
 */
export function isRecognised(match: CustomerMatch<MatchableCustomer> | null): boolean {
  return Boolean(match && match.confidence !== 'default');
}
