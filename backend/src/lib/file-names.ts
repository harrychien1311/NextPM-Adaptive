/**
 * Non-ASCII file names survive a round trip only if both ends are handled explicitly.
 *
 * Inbound: the multipart spec predates UTF-8 being universal, and busboy (under multer) decodes
 * the `filename` parameter as latin1. A Korean, Vietnamese or Japanese name therefore arrives as
 * its UTF-8 bytes reinterpreted one-byte-per-character — "Kế hoạch" becomes "Káº¿ hoáº¡ch".
 *
 * Outbound: HTTP header values are latin1 too, so the real name cannot simply be written into
 * `Content-Disposition`. RFC 5987 defines the `filename*` form for exactly this.
 */

/**
 * Repairs a multipart file name that was decoded as latin1.
 *
 * Only rewrites the name when the latin1 bytes are in fact valid UTF-8 — a name that was already
 * correct (plain ASCII, or a genuinely latin1 name like "café.txt") round-trips unchanged, so
 * this can never double-decode.
 */
export function decodeUploadFileName(name: string): string {
  const bytes = Buffer.from(name, 'latin1');
  const asUtf8 = bytes.toString('utf8');
  return Buffer.from(asUtf8, 'utf8').equals(bytes) ? asUtf8 : name;
}

/**
 * Builds a `Content-Disposition` value that works everywhere: a stripped ASCII `filename` for old
 * clients, plus the RFC 5987 `filename*` that every current browser prefers and reads as UTF-8.
 */
export function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
