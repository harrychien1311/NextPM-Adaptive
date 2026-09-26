/**
 * Fills a customer's own `.docx` in place: unzip, replace the placeholder text, rezip — the Word
 * counterpart of `pptx-fill.ts`, for the same reason: the customer's styles, numbering, headers,
 * footers and logo survive because nothing but the placeholder text is touched.
 *
 * Word splits one visible string across several `<w:t>` runs just as PowerPoint does (a proofing
 * mark or a revision boundary mid-word is enough), so the same two paths apply:
 *
 * - **Token inside one run** → replace within that run; every other run keeps its formatting.
 * - **Token split across runs** → collapse *that paragraph's* text into its first run and blank the
 *   rest. Formatting differences inside that one paragraph are lost, which is why it is the fallback.
 *
 * The body, every header and every footer are filled — a Word template very often carries the
 * project name and date in its header. A line break in a value becomes a real `<w:br/>`, and an
 * unanswered `{{gap:N}}` renders as "[ answer needed ]", never as the raw token.
 */

import JSZip from 'jszip';
import { GAP_LABEL, splitOnGaps } from '../modules/documents/document-format';

const FILLABLE_PART = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;

const W_T = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const W_P = /<w:p\b[\s\S]*?<\/w:p>/g;

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

/** One `<w:t>` holding `text`, with line breaks as real breaks inside the same run. */
function textRun(text: string): string {
  return `<w:t xml:space="preserve">${escapeXml(text).replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">')}</w:t>`;
}

export interface DocxFillResult {
  buffer: Buffer;
  replaced: string[];
  missing: string[];
}

/** @param values placeholder token → the text to put in its place. Values may contain `{{gap:N}}`. */
export async function fillDocxTemplate(source: Buffer, values: Map<string, string>): Promise<DocxFillResult> {
  const zip = await JSZip.loadAsync(source);
  const replaced = new Set<string>();

  // Longest token first, so `[Dev #1 Name]` is never half-eaten by a shorter token.
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

  const fillParagraph = (paragraph: string): string => {
    const runs = [...paragraph.matchAll(new RegExp(W_T.source, 'g'))];
    if (!runs.length) return paragraph;

    const joined = runs.map((run) => unescapeXml(run[1])).join('');
    if (!tokens.some((token) => joined.includes(token))) return paragraph;

    const perRunIsEnough = tokens
      .filter((token) => joined.includes(token))
      .every((token) => runs.some((run) => unescapeXml(run[1]).includes(token)));

    if (perRunIsEnough) {
      return paragraph.replace(new RegExp(W_T.source, 'g'), (match, inner: string) => {
        const text = unescapeXml(inner);
        const next = substitute(text);
        return next === text ? match : textRun(next);
      });
    }

    const merged = substitute(joined);
    let first = true;
    return paragraph.replace(new RegExp(W_T.source, 'g'), () => {
      if (first) {
        first = false;
        return textRun(merged);
      }
      return '<w:t></w:t>';
    });
  };

  for (const name of Object.keys(zip.files)) {
    if (!FILLABLE_PART.test(name)) continue;
    const xml = await zip.file(name)!.async('string');
    const next = xml.replace(W_P, fillParagraph);
    if (next !== xml) zip.file(name, next);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, replaced: [...replaced], missing: tokens.filter((token) => !replaced.has(token)) };
}
