/** Filling a required field gets halfway credit; PM verification gets the rest. */
export function computeInputReadiness(values: { value: string | null; verified: boolean; required: boolean }[]) {
  const required = values.filter((v) => v.required);
  if (!required.length) return { readiness: 0, filled: 0, verified: 0, total: 0 };
  const filled = required.filter((v) => Boolean(v.value)).length;
  const verified = required.filter((v) => v.verified && Boolean(v.value)).length;
  return {
    readiness: Math.round(((filled + verified) / (required.length * 2)) * 100),
    filled,
    verified,
    total: required.length,
  };
}
