/**
 * Finds the fill-in-the-blank placeholders in a customer's own document template.
 *
 * Why the template is kept as the original binary and scanned rather than re-drawn: SKAX's kickoff
 * deck carries their masters, fonts, colours and 24 images. Regenerating that from a description
 * would lose it. Filling it in place — unzip, replace the placeholder text, rezip — keeps the
 * customer's deck exactly as their reviewers expect it.
 *
 * The one real hazard is that PowerPoint and Word split a single visible string across several
 * `<a:t>` / `<w:t>` runs (a spell-check or language mark mid-word is enough), so a naive string
 * replace silently finds nothing. This scanner therefore reports, per placeholder, whether it sits
 * inside one run or is split across several — `splitAcrossRuns` is what tells the filler it must
 * merge the paragraph's runs before substituting. On the SKAX deck 14 of 15 tokens are intact and
 * only `[DM Name]` is split, but a template added later may be worse, and silence would be a bug.
 */

import JSZip from 'jszip';

export interface TemplatePlaceholder {
  /** The literal text to replace, e.g. `[PM Name]`. */
  token: string;
  /** How many times it appears across the whole file. */
  occurrences: number;
  /** Where it appears — "slide 4", "slide 12" — so a reviewer can find it. */
  locations: string[];
  /** True when at least one occurrence is broken across runs and needs run merging first. */
  splitAcrossRuns: boolean;
}

/** One entry of a template's own structure: a Word heading, a slide title or a sheet name. */
export interface TemplateOutlineEntry {
  /** 1 for a top-level heading, slide or sheet; 2-3 for Word sub-headings. */
  level: number;
  text: string;
}

export interface ParsedTemplate {
  fileType: 'PPTX' | 'DOCX' | 'XLSX';
  placeholders: TemplatePlaceholder[];
  /**
   * The template's structure, in order. A template with too few blanks to fill in place is still
   * the customer's statement of how the document is laid out, so the drafted document follows this.
   */
  outline: TemplateOutlineEntry[];
  /** Slides for a deck, pages are not counted for Word. */
  partCount: number;
  /** Whether this template has enough blanks to be filled in place — see MIN_PLACEHOLDERS_TO_FILL. */
  usableForFill: boolean;
  note: string;
}

/**
 * Explains, in the uploader's terms, why a template will or will not be filled in place.
 * `slides` is omitted where the count is not known (it is not stored on the template row).
 */
export function fillabilityNote(placeholders: number, slides?: number): string {
  if (placeholders >= MIN_PLACEHOLDERS_TO_FILL) {
    return `${placeholders} blanks to fill — this file will be filled in place, keeping its layout and branding.`;
  }
  const where = slides ? ` across ${slides} slide${slides === 1 ? '' : 's'}` : '';
  return (
    `Only ${placeholders} blank${placeholders === 1 ? '' : 's'} found${where}. ` +
    'This reads as an outline template whose content is example text to overwrite, not blanks to fill. ' +
    'Filling it would hand the PM that example content under their own project name, so generation instead ' +
    'drafts the document from the project’s own data, following this template’s structure and file format. ' +
    'To have this file filled in place, mark its variable text with [square brackets].'
  );
}

/** Caps, so a 200-heading manual does not become a 200-section prompt. */
const MAX_OUTLINE_ENTRIES = 40;
const MAX_OUTLINE_TEXT = 120;

function pushOutline(outline: TemplateOutlineEntry[], level: number, raw: string) {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_OUTLINE_TEXT);
  if (!text || outline.length >= MAX_OUTLINE_ENTRIES) return;
  const last = outline[outline.length - 1];
  if (last && last.text === text && last.level === level) return; // a repeated running title
  outline.push({ level, text });
}

/**
 * Which Word paragraph styles are headings, and at what level.
 *
 * Read from `styles.xml` rather than guessed from style ids, because the ids are localised: an
 * English template says `Heading1`, a Korean one very often says `1` or `제목1`. A style counts when
 * its *name* is "heading N" / "title", or it carries an outline level of 0-2.
 */
function headingStyles(stylesXml: string | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  for (const style of (stylesXml ?? '').matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const [, id, body] = style;
    const name = body.match(/<w:name w:val="([^"]+)"/)?.[1]?.toLowerCase() ?? '';
    const outlineLevel = body.match(/<w:outlineLvl w:val="(\d)"/)?.[1];
    const named = name.match(/^heading (\d)$/)?.[1];
    if (name === 'title') levels.set(id, 1);
    else if (named && Number(named) <= 3) levels.set(id, Number(named));
    else if (outlineLevel !== undefined && Number(outlineLevel) <= 2) levels.set(id, Number(outlineLevel) + 1);
  }
  return levels;
}

function docxOutline(documentXml: string, stylesXml: string | undefined): TemplateOutlineEntry[] {
  const styles = headingStyles(stylesXml);
  const outline: TemplateOutlineEntry[] = [];
  for (const paragraph of documentXml.matchAll(new RegExp(PARAGRAPH.docx.source, 'g'))) {
    const xml = paragraph[0];
    const styleId = xml.match(/<w:pStyle w:val="([^"]+)"/)?.[1];
    const direct = xml.match(/<w:outlineLvl w:val="(\d)"/)?.[1];
    const level = styleId && styles.has(styleId) ? styles.get(styleId)! : direct !== undefined && Number(direct) <= 2 ? Number(direct) + 1 : null;
    if (level === null) continue;
    pushOutline(outline, level, runTexts(xml, 'docx').join(''));
  }
  return outline;
}

/** A slide's title placeholder text, in slide order. Slides without a title are skipped. */
function pptxOutline(slideXmls: string[]): TemplateOutlineEntry[] {
  const outline: TemplateOutlineEntry[] = [];
  for (const xml of slideXmls) {
    const title = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].find((shape) =>
      /<p:ph[^>]*type="(title|ctrTitle)"/.test(shape[0]),
    );
    if (title) pushOutline(outline, 1, runTexts(title[0], 'pptx').join(''));
  }
  return outline;
}

/**
 * The outline of an already-stored template, for rows uploaded before `outline` was recorded.
 * Never throws — a template whose structure cannot be read simply has none.
 */
export async function readTemplateOutline(buffer: Buffer, fileName: string): Promise<TemplateOutlineEntry[]> {
  try {
    return (await parseTemplate(buffer, fileName)).outline;
  } catch {
    return [];
  }
}

/**
 * What counts as a blank:
 *
 * - `[Project Name]`, `<PROJECT NAME>`, `＜이름＞` — bracketed runs of a few words, not sentences.
 * - Date stubs. Corporate templates very often write the date as `YYYY.MM.DD` or `yyyymmdd`
 *   rather than bracketing it, and those are genuinely fillable — the LGCNS deck marks its dates
 *   that way and nothing else, so ignoring them lost real blanks.
 */
const TOKEN_PATTERN =
  /\[[^\][<>]{2,40}\]|<[^<>[\]]{2,120}>|＜[^＞]{2,40}＞|\byyyy[.\-/]?mm[.\-/]?dd\b|\byyyy\b/gi;

/** The unbracketed date stubs above, recognised again so the workbook scanner can drop them. */
const DATE_STUB = /^(yyyy[.\-/]?mm[.\-/]?dd|yyyy)$/i;

/**
 * Below this many blanks, a template is an *outline* deck rather than a fill-in-the-blank one:
 * its slides carry example content a PM is expected to overwrite, not gaps to drop values into.
 * Filling such a template would hand the PM another project's example text under their own project
 * name, so generation builds a neutral deck instead and says why. The SKAX kickoff deck has 16
 * blanks across 30 slides; the LGCNS one has 4 across 34, which is the case this guards.
 */
export const MIN_PLACEHOLDERS_TO_FILL = 5;

const TEXT_RUN = {
  pptx: /<a:t>([\s\S]*?)<\/a:t>/g,
  docx: /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g,
} as const;

const PARAGRAPH = {
  pptx: /<a:p>[\s\S]*?<\/a:p>/g,
  docx: /<w:p\b[\s\S]*?<\/w:p>/g,
} as const;

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function runTexts(xml: string, flavour: 'pptx' | 'docx'): string[] {
  const pattern = new RegExp(TEXT_RUN[flavour].source, 'g');
  return [...xml.matchAll(pattern)].map((match) => unescapeXml(match[1]));
}

/**
 * Scans one XML part. Returns every token found in the *joined* paragraph text (which is what the
 * reader sees), flagging the ones that no single run contains on its own.
 */
function scanPart(xml: string, flavour: 'pptx' | 'docx', label: string) {
  const found: { token: string; split: boolean; label: string }[] = [];

  const intact = new Set<string>();
  for (const run of runTexts(xml, flavour)) {
    for (const match of run.matchAll(TOKEN_PATTERN)) intact.add(match[0]);
  }

  const paragraphPattern = new RegExp(PARAGRAPH[flavour].source, 'g');
  for (const paragraph of xml.matchAll(paragraphPattern)) {
    const joined = runTexts(paragraph[0], flavour).join('');
    for (const match of joined.matchAll(TOKEN_PATTERN)) {
      found.push({ token: match[0], split: !intact.has(match[0]), label });
    }
  }
  return found;
}

/** Numeric order, so slide 10 does not sort before slide 2. */
function byNumber(a: string, b: string): number {
  const num = (value: string) => Number(value.match(/(\d+)/)?.[1] ?? 0);
  return num(a) - num(b);
}

function collect(found: { token: string; split: boolean; label: string }[]): TemplatePlaceholder[] {
  const byToken = new Map<string, TemplatePlaceholder>();
  for (const hit of found) {
    const existing = byToken.get(hit.token);
    if (existing) {
      existing.occurrences += 1;
      existing.splitAcrossRuns ||= hit.split;
      if (!existing.locations.includes(hit.label)) existing.locations.push(hit.label);
    } else {
      byToken.set(hit.token, {
        token: hit.token,
        occurrences: 1,
        locations: [hit.label],
        splitAcrossRuns: hit.split,
      });
    }
  }
  for (const placeholder of byToken.values()) placeholder.locations.sort(byNumber);
  return [...byToken.values()].sort((a, b) => a.token.localeCompare(b.token));
}

export async function parseTemplate(buffer: Buffer, fileName: string): Promise<ParsedTemplate> {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  const zip = await JSZip.loadAsync(buffer);

  if (ext === '.pptx') {
    const slides = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort(byNumber);

    const found: { token: string; split: boolean; label: string }[] = [];
    const slideXmls: string[] = [];
    for (const name of slides) {
      const xml = await zip.file(name)!.async('string');
      slideXmls.push(xml);
      const number = name.match(/slide(\d+)\.xml/)?.[1] ?? '?';
      found.push(...scanPart(xml, 'pptx', `slide ${number}`));
    }

    const placeholders = collect(found);
    const split = placeholders.filter((p) => p.splitAcrossRuns);
    const note = [
      `PowerPoint template · ${slides.length} slide(s) · ${placeholders.length} placeholder(s)`,
      split.length
        ? `${split.length} split across runs (${split.map((p) => p.token).join(', ')}) — these need run merging before substitution`
        : 'all placeholders sit inside a single text run',
      fillabilityNote(placeholders.length, slides.length),
    ].join(' · ');

    return {
      fileType: 'PPTX',
      placeholders,
      outline: pptxOutline(slideXmls),
      partCount: slides.length,
      usableForFill: placeholders.length >= MIN_PLACEHOLDERS_TO_FILL,
      note,
    };
  }

  if (ext === '.docx') {
    const entry = zip.file('word/document.xml');
    if (!entry) {
      return {
        fileType: 'DOCX',
        placeholders: [],
        outline: [],
        partCount: 0,
        usableForFill: false,
        note: 'Not a readable Word document.',
      };
    }
    const xml = await entry.async('string');
    // Headers and footers too: a Word template very often carries the project name and the date
    // there, and `lib/docx-fill.ts` fills them, so the count must include them.
    const found = scanPart(xml, 'docx', 'document');
    for (const name of Object.keys(zip.files).filter((part) => /^word\/(header|footer)\d*\.xml$/.test(part)).sort()) {
      found.push(...scanPart(await zip.file(name)!.async('string'), 'docx', name.includes('header') ? 'header' : 'footer'));
    }
    const placeholders = collect(found);
    const split = placeholders.filter((p) => p.splitAcrossRuns);
    return {
      fileType: 'DOCX',
      placeholders,
      outline: docxOutline(xml, await zip.file('word/styles.xml')?.async('string')),
      partCount: 1,
      usableForFill: placeholders.length >= MIN_PLACEHOLDERS_TO_FILL,
      note: `Word template · ${placeholders.length} placeholder(s)${
        split.length ? ` · ${split.length} split across runs` : ''
      } · ${fillabilityNote(placeholders.length, 1)}`,
    };
  }

  if (ext === '.xlsx' || ext === '.xlsm') {
    /**
     * A workbook keeps nearly all its text in one shared-strings table rather than in the sheets,
     * so that is where the placeholders live. There is no run-splitting to worry about here — a
     * shared string is a single string — which is why `splitAcrossRuns` is always false.
     */
    const entry = zip.file('xl/sharedStrings.xml');
    const strings = entry ? [...(await entry.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)] : [];
    const found: { token: string; split: boolean; label: string }[] = [];
    for (const match of strings) {
      const text = unescapeXml(match[1].replace(/<[^>]+>/g, ''));
      for (const hit of text.matchAll(TOKEN_PATTERN)) {
        // A bare date stub is a blank on a slide and a *column format label* in a workbook: the
        // Project Plan template writes "dd/mm/yyyy" as a header, and filling the `yyyy` inside it
        // would leave the sheet saying "dd/mm/2026".
        if (DATE_STUB.test(hit[0])) continue;
        found.push({ token: hit[0], split: false, label: 'workbook' });
      }
    }

    const sheetNames = (await zip.file('xl/workbook.xml')?.async('string'))?.match(/<sheet[^>]*name="[^"]+"/g) ?? [];
    const placeholders = collect(found);
    const outline: TemplateOutlineEntry[] = [];
    for (const sheet of sheetNames) pushOutline(outline, 1, unescapeXml(sheet.match(/name="([^"]+)"/)?.[1] ?? ''));
    return {
      fileType: 'XLSX',
      placeholders,
      outline,
      partCount: sheetNames.length,
      usableForFill: placeholders.length >= MIN_PLACEHOLDERS_TO_FILL,
      note:
        `Excel template · ${sheetNames.length} sheet(s) · ${placeholders.length} placeholder(s) · ` +
        fillabilityNote(placeholders.length),
    };
  }

  return {
    fileType: 'XLSX',
    placeholders: [],
    outline: [],
    partCount: 0,
    usableForFill: false,
    note: `${ext || 'This file type'} is stored but not scanned for placeholders — upload .pptx, .docx or .xlsx.`,
  };
}
