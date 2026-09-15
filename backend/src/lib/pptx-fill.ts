/**
 * Fills a customer's own `.pptx` in place: unzip, replace the placeholder text, rezip.
 *
 * Why in place rather than generating a deck: SKAX's kickoff template carries their slide masters,
 * fonts, colours and 24 images across 30 slides. Redrawing that from a description would produce
 * something that is not their deck. Replacing only the text leaves everything else untouched, so
 * what the customer's reviewers open is the file they designed.
 *
 * The hazard this file exists to handle is that PowerPoint splits one visible string across
 * several `<a:t>` runs — a language mark or a spell-check boundary mid-word is enough. On the SKAX
 * deck 15 of 16 placeholders sit inside a single run and one, `[DM Name]`, does not. So:
 *
 * - **Token inside one run** → replace within that run. Every other run keeps its own formatting.
 * - **Token split across runs** → collapse *that paragraph* into its first run and blank the rest.
 *   Formatting differences within that one paragraph are lost, which is why it is the fallback and
 *   not the default. Losing them silently on every paragraph would be much worse.
 *
 * Unanswered `{{gap:N}}` tokens never reach the file: they render as a visible "[ answer needed ]"
 * marker, the same as in the Word and Excel exports.
 */

import JSZip from 'jszip';
import { GAP_LABEL, splitOnGaps } from '../modules/documents/document-format';

/** Slides, plus the parts that can also hold visible text. Masters and layouts are left alone. */
const FILLABLE_PART = /^ppt\/(slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml)$/;

const A_T = /<a:t>([\s\S]*?)<\/a:t>/g;
const A_P = /<a:p>[\s\S]*?<\/a:p>/g;
/** One shape: the only scope holding both its text and its geometry. */
const P_SP = /<p:sp>[\s\S]*?<\/p:sp>/g;
/** A shape's text, which is where `<a:bodyPr>` lives. */
const P_TXBODY = /<p:txBody>[\s\S]*?<\/p:txBody>/g;
/** Table-cell text. No autofit of its own: a table row grows, which is correct behaviour. */
const A_TXBODY = /<a:txBody>[\s\S]*?<\/a:txBody>/g;

/**
 * Smallest the text may be shrunk to. Below this a slide is unreadable, so it is better to let it
 * overflow visibly — the PM can then shorten the value, which is the real fix for text that long.
 */
const MIN_FONT_SCALE = 0.55;


const EMU_PER_POINT = 12_700;
/** PowerPoint's default run size when a run does not state one, in hundredths of a point. */
const DEFAULT_RUN_SIZE = 1800;

/**
 * Roughly how wide one character is, as a multiple of the font size.
 *
 * Counting characters is not good enough here: a Hangul or Han glyph occupies a full em where a
 * Latin letter takes about half of one, so "GDC 차세대 물류 플랫폼" is far wider than its 17
 * characters suggest. Getting that wrong was why the first attempt shrank the title by 4% when it
 * needed far more.
 */
function charWidthFactor(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  // Hangul, CJK ideographs, kana and full-width forms.
  if (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xff60)
  ) {
    return 1;
  }
  return char === ' ' ? 0.28 : 0.52;
}

/** Widest line this paragraph would need, in EMU, at its own run sizes. */
function paragraphWidthEmu(paragraph: string): number {
  let width = 0;
  const runs = paragraph.match(/<a:r>[\s\S]*?<\/a:r>/g) ?? [paragraph];
  for (const run of runs) {
    const size = Number(run.match(/\bsz="(\d+)"/)?.[1] ?? DEFAULT_RUN_SIZE) / 100;
    for (const match of run.matchAll(new RegExp(A_T.source, 'g'))) {
      for (const char of unescapeXml(match[1])) width += charWidthFactor(char) * size * EMU_PER_POINT;
    }
  }
  return width;
}

/**
 * Keeps filled text inside the box the template drew for it.
 *
 * The SKAX kickoff title uses `spAutoFit` — "resize the shape to fit the text". The template
 * stores a shape height computed for the short `<PROJECT NAME>` placeholder on **one line**, so a
 * longer real name wraps to two and PowerPoint grows the shape downwards at render time, straight
 * through the fixed-position elements beneath it. Real PowerPoint renders that collision exactly
 * as LibreOffice does, so this is the file being wrong, not a viewer disagreeing.
 *
 * The fix changes what "fit" means for the shape: `normAutofit` shrinks the *text* into the
 * existing box instead of growing the box. PowerPoint applies the stored `fontScale` as-is, so it
 * has to be computed here — and it is computed from how wide the longest line would actually be
 * against the shape's own width, because the thing to avoid is the wrap, not "more characters".
 *
 * Approximate, deliberately: without font metrics an estimate is the honest ceiling. It is bounded
 * by `MIN_FONT_SCALE`, and a slightly-too-small title is a far better failure than two lines of
 * text lying on top of each other.
 */
function keepTextInsideShape(body: string, before: string, boxWidthEmu: number | null): string {
  // Insets, defaulting to PowerPoint's own 0.1" left/right.
  const lIns = Number(body.match(/\blIns="(\d+)"/)?.[1] ?? 91_440);
  const rIns = Number(body.match(/\brIns="(\d+)"/)?.[1] ?? 91_440);
  const available = boxWidthEmu ? boxWidthEmu - lIns - rIns : 0;

  const widest = (xml: string) => Math.max(...(xml.match(A_P) ?? []).map(paragraphWidthEmu), 0);
  const widestBefore = widest(before);
  const widestAfter = widest(body);

  if (process.env.PPTX_FILL_DEBUG) {
    console.log(
      `[fit] before=${(widestBefore / 914_400).toFixed(2)}in ` +
        `after=${(widestAfter / 914_400).toFixed(2)}in available=${(available / 914_400).toFixed(2)}in`,
    );
  }
  if (!available) return body;

  /**
   * Only intervene where **this fill** caused the overflow: the text fitted on one line before and
   * does not now. A body box whose text was already wider than the box is *designed* to wrap, and
   * shrinking that to one line would wreck a slide that was never broken.
   */
  if (widestBefore > available || widestAfter <= available) return body;

  /**
   * Everything is decided on estimated *width*, never on character count. Counting characters is
   * what let this bug through the first time: `<PROJECT NAME>` and `GDC 차세대 물류 플랫폼` are both
   * exactly 14 characters, yet the Korean one is half again as wide, because a Hangul glyph fills
   * a full em where a Latin letter takes about half of one.
   *
   * The 3% margin covers the estimate running low: landing slightly small is invisible, landing
   * slightly large puts the text back on two lines and the whole fix was for nothing.
   */
  const scale = Math.max(MIN_FONT_SCALE, (available * 0.97) / widestAfter);
  if (scale > 0.97) return body; // not worth rewriting the shape for

  // Thousandths of a percent, as the OOXML attribute is defined.
  const fontScale = Math.round(scale * 100_000);
  // Tightening line spacing buys back vertical room; only worth it once the text is really long.
  const lnSpcReduction = scale < 0.85 ? 20_000 : 10_000;
  const autofit = `<a:normAutofit fontScale="${fontScale}" lnSpcReduction="${lnSpcReduction}"/>`;

  // `spAutoFit` → `normAutofit`: stop growing the shape, start shrinking the text.
  if (body.includes('<a:spAutoFit/>')) return body.replace('<a:spAutoFit/>', autofit);

  // An existing `normAutofit` already shrinks; re-scale it for the new, longer text.
  if (/<a:normAutofit[^>]*\/>/.test(body)) return body.replace(/<a:normAutofit[^>]*\/>/, autofit);

  // No autofit at all means the text simply overflows the box. Shrinking is still better.
  if (/<a:bodyPr([^>]*)\/>/.test(body)) {
    return body.replace(/<a:bodyPr([^>]*)\/>/, `<a:bodyPr$1>${autofit}</a:bodyPr>`);
  }
  if (/<a:bodyPr([^>]*)>/.test(body) && !body.includes('<a:noAutofit/>')) {
    return body.replace(/<a:bodyPr([^>]*)>/, `<a:bodyPr$1>${autofit}`);
  }

  // `noAutofit` is a deliberate choice by whoever made the template — respect it.
  return body;
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
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** An unanswered blank must look like a blank, never like a raw `{{gap:3}}`. */
function renderValue(value: string): string {
  return splitOnGaps(value)
    .map((part) => (part.gap ? GAP_LABEL : part.text))
    .join('');
}

export interface FillResult {
  buffer: Buffer;
  /** Placeholders actually found and replaced, for reporting back to the caller. */
  replaced: string[];
  /** Placeholders the caller supplied that the file does not contain — worth surfacing. */
  missing: string[];
}

/**
 * @param values placeholder token → the text to put in its place. Values may contain `{{gap:N}}`.
 */
export async function fillPptxTemplate(source: Buffer, values: Map<string, string>): Promise<FillResult> {
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

  /** Substitutes inside one paragraph, preserving per-run formatting where it can. */
  const fillParagraph = (paragraph: string): string => {
    const runs = [...paragraph.matchAll(new RegExp(A_T.source, 'g'))];
    if (!runs.length) return paragraph;

    const joined = runs.map((run) => unescapeXml(run[1])).join('');
    if (!tokens.some((token) => joined.includes(token))) return paragraph;

    // Preferred path: every token in this paragraph lives inside a single run, so each run can
    // be rewritten on its own and the paragraph keeps its mixed formatting.
    const perRunIsEnough = tokens
      .filter((token) => joined.includes(token))
      .every((token) => runs.some((run) => unescapeXml(run[1]).includes(token)));

    if (perRunIsEnough) {
      return paragraph.replace(new RegExp(A_T.source, 'g'), (_match, inner: string) => {
        const text = unescapeXml(inner);
        return `<a:t>${escapeXml(substitute(text))}</a:t>`;
      });
    }

    // Fallback: a token straddles runs, so the whole paragraph collapses into its first run.
    const merged = substitute(joined);
    let first = true;
    return paragraph.replace(new RegExp(A_T.source, 'g'), () => {
      if (first) {
        first = false;
        return `<a:t>${escapeXml(merged)}</a:t>`;
      }
      return '<a:t></a:t>';
    });
  };

  for (const name of Object.keys(zip.files)) {
    if (!FILLABLE_PART.test(name)) continue;
    const xml = await zip.file(name)!.async('string');

    // Shape scope, not paragraph scope: the overflow fix needs the shape's autofit setting
    // (`<a:bodyPr>`, inside `<p:txBody>`) *and* its width (`<a:ext cx>`, inside `<p:spPr>`), and
    // those are siblings — only `<p:sp>` contains both.
    let nextXml = xml.replace(P_SP, (shape) => {
      const boxWidthEmu = Number(shape.match(/<a:ext\s+cx="(\d+)"/)?.[1] ?? 0) || null;
      return shape.replace(P_TXBODY, (body) => {
        const filled = body.replace(A_P, fillParagraph);
        return filled === body ? body : keepTextInsideShape(filled, body, boxWidthEmu);
      });
    });

    // A `<p:txBody>` outside any `<p:sp>` is rare but must still be filled — without geometry
    // there is nothing to fit to, so it is substituted and left alone.
    nextXml = nextXml.replace(P_TXBODY, (body) => body.replace(A_P, fillParagraph));

    // Then table cells, which use `<a:txBody>` and have no autofit of their own — a table row
    // grows to fit, which is the layout behaving correctly rather than text escaping a box.
    nextXml = nextXml.replace(A_TXBODY, (body) => body.replace(A_P, fillParagraph));

    if (nextXml !== xml) zip.file(name, nextXml);
  }

  // DEFLATE and the original mimetype layout — PowerPoint is content with a plain rezip.
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return {
    buffer,
    replaced: [...replaced],
    missing: tokens.filter((token) => !replaced.has(token)),
  };
}
