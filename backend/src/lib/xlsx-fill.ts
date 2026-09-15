/**
 * Fills a customer's own `.xlsx` in place: unzip, substitute, rezip.
 *
 * Much simpler than the PowerPoint equivalent. Excel keeps nearly all cell text in one shared
 * strings table, and a shared string is a single string — there is no run-splitting to merge, and
 * no per-shape geometry to keep text inside. Formulas, formatting, merged ranges, column widths
 * and every sheet are untouched, because nothing outside the text is rewritten.
 *
 * One consequence worth knowing: a shared string is *shared*. Replacing it fills every cell that
 * uses that exact text. For placeholders that is what you want — `<Project Name>` appearing on
 * five sheets should be filled on all five — but it is why the substitution must never be applied
 * to ordinary prose that happens to repeat.
 */

import JSZip from 'jszip';
import { GAP_LABEL, splitOnGaps } from '../modules/documents/document-format';

export interface XlsxFillResult {
  buffer: Buffer;
  replaced: string[];
  /** Placeholders the caller supplied that the workbook does not contain. */
  missing: string[];
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An unanswered blank must look like a blank, never like a raw `{{gap:3}}`. */
function renderValue(value: string): string {
  return splitOnGaps(value)
    .map((part) => (part.gap ? GAP_LABEL : part.text))
    .join('');
}

/** `<t>` inside shared strings and inline cell strings alike. */
const T_TAG = /<t(\s[^>]*)?>([\s\S]*?)<\/t>/g;

/**
 * @param values placeholder token → the text to put in its place. A token the caller omits is
 *   left exactly as the template wrote it — for a large template that is the useful default, since
 *   the original text is usually guidance telling the PM what belongs there.
 */
export async function fillXlsxTemplate(source: Buffer, values: Map<string, string>): Promise<XlsxFillResult> {
  const zip = await JSZip.loadAsync(source);
  const replaced = new Set<string>();

  // Longest token first, so a short token never eats part of a longer one.
  const tokens = [...values.keys()].sort((a, b) => b.length - a.length);
  const rendered = new Map([...values.entries()].map(([token, value]) => [token, renderValue(value)]));

  const substitute = (text: string): string => {
    let out = text;
    for (const token of tokens) {
      if (!out.includes(token)) continue;
      replaced.add(token);
      out = out.split(token).join(rendered.get(token) ?? '');
    }
    return out;
  };

  const rewrite = async (name: string) => {
    const file = zip.file(name);
    if (!file) return;
    const xml = await file.async('string');
    const next = xml.replace(T_TAG, (_match, attrs: string | undefined, inner: string) => {
      const text = unescapeXml(inner);
      const filled = substitute(text);
      if (filled === text) return _match;
      // Keep xml:space="preserve" where the template had it, or Excel trims the value.
      return `<t${attrs ?? ''}>${escapeXml(filled)}</t>`;
    });
    if (next !== xml) zip.file(name, next);
  };

  await rewrite('xl/sharedStrings.xml');
  // Inline strings are rare but legal; a workbook written by another tool may use them.
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) await rewrite(name);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, replaced: [...replaced], missing: tokens.filter((token) => !replaced.has(token)) };
}
