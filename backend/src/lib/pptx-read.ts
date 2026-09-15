/**
 * Reads the visible text out of a `.pptx`, slide by slide.
 *
 * This exists so the on-screen preview of a deck can be generated from **the actual file the PM is
 * about to download** rather than from a guess about what it contains. That matters most for a
 * deck filled from a customer's own template: its 30 slides are theirs, and the only honest way to
 * show them is to read them. A preview drawn from the fill values alone would show the handful of
 * blanks and none of the deck.
 *
 * Text only — images, charts and layout are not extracted. The preview says as much rather than
 * pretending to be a renderer.
 */

import JSZip from 'jszip';

export interface DeckSlideText {
  number: number;
  /** One entry per paragraph, in reading order, empties dropped. */
  lines: string[];
  /** Pictures on the slide, so the preview can say what it is not showing. */
  pictures: number;
  hasTable: boolean;
}

const A_P = /<a:p>[\s\S]*?<\/a:p>/g;
/** `<a:br/>` is a visible line break inside one paragraph, so it must become a space. */
const RUN_OR_BREAK = /<a:t>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/?>/g;

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Numeric order, so slide 10 does not sort before slide 2. */
function slideNumber(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

export async function readDeckText(buffer: Buffer): Promise<DeckSlideText[]> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides: DeckSlideText[] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async('string');

    const lines: string[] = [];
    for (const paragraph of xml.match(A_P) ?? []) {
      let text = '';
      for (const match of paragraph.matchAll(new RegExp(RUN_OR_BREAK.source, 'g'))) {
        // Runs inside a paragraph are concatenated with no separator — PowerPoint splits words
        // across runs, so joining with a space would turn "AGS" into "A GS".
        text += match[1] === undefined ? ' ' : unescapeXml(match[1]);
      }
      const cleaned = text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
      if (cleaned) lines.push(cleaned);
    }

    slides.push({
      number: slideNumber(name),
      lines,
      pictures: (xml.match(/<p:pic>/g) ?? []).length,
      hasTable: xml.includes('<a:tbl>'),
    });
  }

  return slides;
}
