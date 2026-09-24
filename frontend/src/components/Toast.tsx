import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface ToastPayload {
  title: string;
  detail?: string;
}

const ToastContext = createContext<(payload: ToastPayload) => void>(() => {});

/**
 * The fallback line says **Decision Log**, not "audit log".
 *
 * The Decision Log is a real document this application produces, under that exact name in all three
 * project types — so the toast names something the PM can open, instead of a concept they would
 * have to go looking for.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const timer = useRef<number>();

  const notify = useCallback((payload: ToastPayload) => {
    setToast(payload);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2700);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className={`toast${toast ? ' show' : ''}`}>
        <span>✓</span>
        <div>
          <strong>{toast?.title ?? 'Saved'}</strong>
          <small>{toast?.detail ?? 'Your decision was added to the Decision Log.'}</small>
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
