/**
 * Reads the text of an `.xlsx` straight from its XML, keeping only the cells that say something.
 *
 * This replaced `ExcelJS.Workbook.xlsx.load` for every *read* in the app (the checklist parser, the
 * workbook preview, text extraction). ExcelJS builds a full object model — a row object, a cell
 * object and a style object for every cell the sheet ever formatted, value or not — and a real
 * checklist workbook routinely carries borders and fills down thousands of empty rows. Uploading
 * one to the FPT library ran the 512 MB Render instance out of heap and restarted the API. Here a
 * formatted empty cell is a regular-expression match that is thrown away, so memory follows the
 * text the workbook holds, not the area it styled. ExcelJS is still what *writes* workbooks
 * (`xlsx-export.ts`); writing builds only what we put in.
 *
 * Text, merges and sheet visibility only — the same things the readers used from ExcelJS.
 */

import JSZip from 'jszip';

export interface CellMerge {
  /** 1-based and inclusive, as Excel writes them. */
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface SheetCells {
  name: string;
  hidden: boolean;
  /** row → column → text, 1-based. Only cells with a non-empty value are present. */
  cells: Map<number, Map<number, string>>;
  merges: CellMerge[];
  /** The last row and column holding a value — the used range, not the formatted one. */
  maxRow: number;
  maxCol: number;
  /** Set when the sheet was not read, saying why; `cells` is then empty. */
  skipped?: string;
}

/**
 * One sheet's XML is decompressed into a single string, so a sheet this large is refused rather
 * than read. It is far beyond any checklist or plan: a sheet of 50k filled rows is a few tens of MB.
 */
const MAX_SHEET_XML_BYTES = 64 * 1024 * 1024;

function unescapeXml(value: string): string {
  return value
    // An XML parser turns a literal CR LF (or lone CR) into LF before anything else (XML 1.0 §2.11);
    // reading the raw text, that is ours to do.
    .replace(/\r\n?/g, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    // Excel escapes control characters it cannot store as XML — a line break in a cell is _x000D_.
    .replace(/_x([0-9A-F]{4})_/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * The visible text of a rich string: its `<t>` runs joined with no separator. Phonetic guides
 * (`<rPh>`, the reading Excel stores above Korean or Japanese text) are not part of what the cell
 * shows, so they are dropped first.
 */
function stringItemText(xml: string): string {
  const visible = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const match of visible.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += match[1] ? unescapeXml(match[1]) : '';
  }
  return out;
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

/** "AB" → 28. */
function columnNumber(letters: string): number {
  let total = 0;
  for (const letter of letters.toUpperCase()) total = total * 26 + (letter.charCodeAt(0) - 64);
  return total;
}

function parseRef(ref: string): { row: number; col: number } | null {
  const match = ref.match(/^\$?([A-Z]+)\$?(\d+)$/i);
  return match ? { col: columnNumber(match[1]), row: Number(match[2]) } : null;
}

function parseRange(ref: string): CellMerge | null {
  const [from, to] = ref.split(':');
  const a = parseRef(from ?? '');
  const b = parseRef(to ?? '');
  if (!a || !b) return null;
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.col, b.col),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.col, b.col),
  };
}

/** Built-in number formats that display a date (ECMA-376 §18.8.30, plus the CJK date formats). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);

/** A custom format shows a date when it has day or year codes outside quotes, brackets and escapes. */
function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(bare);
}

/** For each cell style index, whether it formats its number as a date. */
async function dateStyles(zip: JSZip): Promise<boolean[]> {
  const xml = await zip.file('xl/styles.xml')?.async('string');
  if (!xml) return [];
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1]);
    custom.set(Number(attrs.numFmtId), unescapeXml(attrs.formatCode ?? ''));
  }
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '';
  return [...cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((match) => {
    const id = Number(attributes(match[1]).numFmtId ?? 0);
    return BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormatCode(custom.get(id)!));
  });
}

function serialToIsoDate(serial: number, date1904: boolean): string {
  const epochOffset = date1904 ? 24107 : 25569; // days from the workbook's epoch to 1970-01-01
  return new Date(Math.round((serial - epochOffset) * 86_400_000)).toISOString().slice(0, 10);
}

/** Resolves a relationship target against `xl/`, the folder `workbook.xml` lives in. */
function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ['xl'];
  for (const part of target.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** JSZip keeps each entry's declared size; reading it lets a huge sheet be refused before inflating. */
function uncompressedSize(entry: JSZip.JSZipObject): number | null {
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  return typeof size === 'number' ? size : null;
}

export async function readSheetCells(buffer: Buffer): Promise<SheetCells[]> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  if (!workbookXml) throw new Error('Not a readable workbook — xl/workbook.xml is missing');

  const relsXml = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1]);
    if (attrs.Id && attrs.Target) targets.set(attrs.Id, resolveTarget(attrs.Target));
  }

  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbookXml);

  const sharedStringsXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const shared = [...sharedStringsXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((match) =>
    match[1] ? stringItemText(match[1]) : '',
  );
  const dates = await dateStyles(zip);

  const sheets: SheetCells[] = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1]);
    const name = unescapeXml(attrs.name ?? '');
    const hidden = attrs.state === 'hidden' || attrs.state === 'veryHidden';
    const sheet: SheetCells = { name, hidden, cells: new Map(), merges: [], maxRow: 0, maxCol: 0 };
    sheets.push(sheet);

    const path = targets.get(attrs['r:id'] ?? '');
    const entry = path ? zip.file(path) : null;
    // A chart sheet is a relationship to a drawing, not a worksheet — nothing to read.
    if (!entry || !path?.includes('worksheets/')) continue;
    const size = uncompressedSize(entry);
    if (size !== null && size > MAX_SHEET_XML_BYTES) {
      sheet.skipped = `sheet is ${Math.round(size / 1024 / 1024)} MB of XML — too large to read`;
      continue;
    }

    const xml = await entry.async('string');
    readSheetXml(xml, sheet, shared, dates, date1904);
  }
  return sheets;
}

function readSheetXml(xml: string, sheet: SheetCells, shared: string[], dates: boolean[], date1904: boolean) {
  const data = xml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/)?.[1] ?? '';
  let rowNumber = 0;
  for (const rowMatch of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttrs = attributes(rowMatch[1]);
    rowNumber = rowAttrs.r ? Number(rowAttrs.r) : rowNumber + 1;
    const body = rowMatch[2];
    if (!body) continue;

    let column = 0;
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attributes(cellMatch[1]);
      const ref = attrs.r ? parseRef(attrs.r) : null;
      column = ref ? ref.col : column + 1;
      const inner = cellMatch[2];
      if (!inner) continue; // formatted but empty — the case that made ExcelJS run out of memory

      const text = cellValue(inner, attrs, shared, dates, date1904);
      if (!text) continue;
      let row = sheet.cells.get(rowNumber);
      if (!row) sheet.cells.set(rowNumber, (row = new Map()));
      row.set(column, text);
      if (rowNumber > sheet.maxRow) sheet.maxRow = rowNumber;
      if (column > sheet.maxCol) sheet.maxCol = column;
    }
  }

  for (const match of xml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)) {
    const merge = parseRange(match[1]);
    if (merge && (merge.bottom > merge.top || merge.right > merge.left)) sheet.merges.push(merge);
  }
}

function cellValue(
  inner: string,
  attrs: Record<string, string>,
  shared: string[],
  dates: boolean[],
  date1904: boolean,
): string {
  const type = attrs.t;
  if (type === 'inlineStr') {
    const is = inner.match(/<is>([\s\S]*?)<\/is>/)?.[1];
    return is ? stringItemText(is) : '';
  }
  const raw = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (raw === undefined) return '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'str' || type === 'e') return unescapeXml(raw);
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  const number = Number(raw);
  if (!Number.isFinite(number)) return unescapeXml(raw);
  if (attrs.s && dates[Number(attrs.s)]) return serialToIsoDate(number, date1904);
  return String(number);
}
