/**
 * Inline SVG icons. Inline rather than an icon font or CDN package so the app keeps working
 * offline and inside the container image, and so the glyph inherits `currentColor` on both the
 * dark sidebar and the light portfolio header.
 */

/** The conventional "log out" mark: a door frame with an arrow leaving it. */
export function SignOutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
