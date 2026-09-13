/**
 * Filling a field gets halfway credit; PM verification gets the rest.
 *
 * Scored over *every* field of the project type, not only the required ones. Only the project
 * name and the objective are required (they gate the flow), so a required-only denominator would
 * read 100% with thirteen fields still empty — which is the opposite of what "input readiness"
 * is meant to tell the PM.
 */
export function computeInputReadiness(values: { value: string | null; verified: boolean; required: boolean }[]) {
  if (!values.length) return { readiness: 0, filled: 0, verified: 0, total: 0 };
  const filled = values.filter((v) => Boolean(v.value)).length;
  const verified = values.filter((v) => v.verified && Boolean(v.value)).length;
  return {
    readiness: Math.round(((filled + verified) / (values.length * 2)) * 100),
    filled,
    verified,
    total: values.length,
  };
}
