import { useCallback, useEffect, useRef } from 'react';

/** Used for the auto-save behaviour on the project input form. */
export function useDebouncedCallback<T extends (...args: never[]) => void>(fn: T, delay = 800) {
  const timer = useRef<number>();
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return useCallback(
    (...args: Parameters<T>) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => latest.current(...args), delay);
    },
    [delay],
  );
}
