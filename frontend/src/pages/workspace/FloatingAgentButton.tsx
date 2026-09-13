import { useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'nextpm.agentButtonPosition';
/** Pointer travel, in px, that turns a click into a drag. Below this, it still opens the chat. */
const DRAG_THRESHOLD = 4;

interface Point {
  x: number;
  y: number;
}

function readStored(): Point | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Point;
    return typeof parsed?.x === 'number' && typeof parsed?.y === 'number' ? parsed : null;
  } catch {
    // Private windows and blocked site data throw here; the default corner is a fine fallback.
    return null;
  }
}

/**
 * The collapsed "Ask Planning Agent" launcher. It sits bottom-right by default but can be dragged
 * anywhere, because a long footer line can end up underneath it. Where the PM puts it is a
 * per-viewer convenience, so it lives in localStorage rather than on the server.
 */
export function FloatingAgentButton({ onOpen }: { onOpen: () => void }) {
  const [position, setPosition] = useState<Point | null>(readStored);
  /** Set during a drag so the click that follows does not also open the chat. */
  const dragged = useRef(false);

  // A window that shrank since last visit could leave the button off-screen.
  useEffect(() => {
    if (!position) return;
    const clamped = {
      x: Math.min(Math.max(position.x, 8), Math.max(window.innerWidth - 220, 8)),
      y: Math.min(Math.max(position.y, 8), Math.max(window.innerHeight - 64, 8)),
    };
    if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped);
    // Only on mount: during a drag the move handler already clamps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startDrag = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const grabX = event.clientX - rect.left;
    const grabY = event.clientY - rect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    dragged.current = false;

    const move = (moveEvent: MouseEvent) => {
      if (
        !dragged.current &&
        Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD &&
        Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD
      ) {
        return; // still within click tolerance
      }
      dragged.current = true;
      setPosition({
        x: Math.min(Math.max(moveEvent.clientX - grabX, 8), window.innerWidth - rect.width - 8),
        y: Math.min(Math.max(moveEvent.clientY - grabY, 8), window.innerHeight - rect.height - 8),
      });
    };

    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (dragged.current) {
        setPosition((current) => {
          try {
            if (current) localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
          } catch {
            // Not being able to remember the position is not worth breaking the button over.
          }
          return current;
        });
      }
    };

    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <button
      className="floating-agent"
      onMouseDown={startDrag}
      onClick={() => {
        if (dragged.current) {
          dragged.current = false;
          return; // that was a drag, not a click
        }
        onOpen();
      }}
      onDoubleClick={() => {
        // Quick way back to the default corner.
        setPosition(null);
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* ignore */
        }
      }}
      title="Ask the Planning Agent · drag to move · double-click to reset its position"
      style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <span>✦</span>
      <div>
        <strong>Ask Planning Agent</strong>
        <small>Copilot Studio</small>
      </div>
    </button>
  );
}
