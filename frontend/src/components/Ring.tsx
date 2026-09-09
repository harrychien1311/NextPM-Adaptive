/** Progress ring used by the readiness and output widgets. */
export function Ring({ value, className = '' }: { value: number; className?: string }) {
  return (
    <div
      className={`ring ${className}`}
      style={{ background: `conic-gradient(var(--blue) ${value * 3.6}deg, #e6ecf4 0deg)` }}
      role="img"
      aria-label={`${value} percent`}
    >
      <span>
        {value}
        <small>%</small>
      </span>
    </div>
  );
}
