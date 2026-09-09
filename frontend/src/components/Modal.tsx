import type { ReactNode } from 'react';

export function Backdrop({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <div className={`modal-backdrop${open ? ' open' : ''}`} onClick={onClose} />;
}

export function ModalShell({
  open,
  className,
  children,
}: {
  open: boolean;
  className: string;
  children: ReactNode;
}) {
  return <div className={`${className}${open ? ' open' : ''}`}>{children}</div>;
}
