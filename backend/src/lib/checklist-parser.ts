/**
 * Turns a customer's checklist file into `ChecklistItem` rows.
 *
 * The two customers we have ship the same *idea* in completely different containers, and that is
 * the point — this is where "adaptive" stops being a slogan:
 *
 * - **LGCNS** (`.xlsx`) is a grid: repeated `구분 | 체크사항 | 답변 | 비고` header rows, two blocks
 *   side by side on the same sheet, and the category column merged vertically down each block.
 *   So the spreadsheet strategy is *header-driven*: find the header row, work out the column
 *   groups, then read rows until the next header.
 * - **SKAX / AGS** (`.docx`) is prose: each check is a *paragraph* ending in a dotted leader and
 *   a `■ Yes  No  N/A` marker, and its tables are reference material (a term glossary, a
 *   stakeholder list, a severity table) attached to the check above them. So the Word strategy is
 *   *marker-driven*: a paragraph carrying that marker is a check; everything else is context.
 *
 * Neither parser interprets or translates — a Korean checklist stays Korean, so the PM can see it
 * is the same document they signed off on. What a parser could not read goes in `note`, never
 * into a silently-dropped row.
 */

import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export interface ParsedChecklistItem {
  order: number;
  section: string | null;
  code: string | null;
  text: string;
  guidance: string | null;
  /** An answer the source document already carried (LGCNS's 답변 column, AGS's ticked box). */
  expected: string | null;
}

export interface ParsedChecklist {
  items: ParsedChecklistItem[];
  /** What the parser did and what it could not read — shown to whoever uploaded the file. */
  note: string;
}

/**
 * ExcelJS throws on `cell.text` for a merged slave whose master is empty, and returns objects for
 * rich text, hyperlinks and formulas. This is the one safe way to ask a cell what it says.
 */
function cellText(cell: ExcelJS.Cell): string {
  try {
    const value = cell.value as unknown;
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
      const record = value as { richText?: { text: string }[]; text?: string; result?: unknown };
      if (Array.isArray(record.richText)) return record.richText.map((run) => run.text).join('');
      if (typeof record.text === 'string') return record.text;
      if (record.result !== undefined && record.result !== null) return String(record.result);
    }
    return typeof cell.text === 'string' ? cell.text : '';
  } catch {
    return '';
  }
}

const clean = (value: string): string =>
  value
    .replace(/ /g, ' ')
    .replace(/[.·…]{4,}/g, ' ') // dotted leaders used as visual filler
    .replace(/\s+/g, ' ')
    .trim();

// ---------------------------------------------------------------------------
// Spreadsheet checklists (LGCNS)
// ---------------------------------------------------------------------------

/** Header labels, in the languages these checklists actually ship in. */
const HEADERS = {
  section: [/^구분$/, /^분류$/, /^area$/i, /^category$/i, /^section$/i],
  text: [/^체크사항$/, /^점검사항$/, /^확인사항$/, /^check/i, /^item$/i, /^question$/i],
  expected: [/^답변$/, /^응답$/, /^answer$/i, /^response$/i],
  guidance: [/^비고$/, /^참고$/, /^note$/i, /^remarks?$/i],
} as const;

type HeaderKind = keyof typeof HEADERS;

function headerKind(value: string): HeaderKind | null {
  const text = clean(value);
  if (!text) return null;
  for (const [kind, patterns] of Object.entries(HEADERS) as [HeaderKind, readonly RegExp[]][]) {
    if (patterns.some((pattern) => pattern.test(text))) return kind;
  }
  return null;
}

/** One `구분 | 체크사항 | 답변 | 비고` block. A sheet may hold several side by side. */
interface ColumnGroup {
  section: number | null;
  text: number;
  expected: number | null;
  guidance: number | null;
}

/**
 * Reads a header row into column groups. Scanning left to right, every "check" column opens a
 * group; the nearest unclaimed "category" column to its left belongs to it, and the answer/note
 * columns to its right do, until the next check column.
 */
function groupsFromHeaderRow(cells: string[]): ColumnGroup[] {
  const kinds = cells.map((cell) => headerKind(cell));
  const groups: ColumnGroup[] = [];

  kinds.forEach((kind, index) => {
    if (kind !== 'text') return;
    let section: number | null = null;
    for (let back = index - 1; back >= 0; back -= 1) {
      if (kinds[back] === 'section' && !groups.some((group) => group.section === back)) {
        section = back;
        break;
      }
      if (kinds[back] === 'text') break; // belongs to the previous group
    }
    const group: ColumnGroup = { section, text: index, expected: null, guidance: null };
    for (let ahead = index + 1; ahead < kinds.length && kinds[ahead] !== 'text'; ahead += 1) {
      if (kinds[ahead] === 'expected' && group.expected === null) group.expected = ahead;
      if (kinds[ahead] === 'guidance' && group.guidance === null) group.guidance = ahead;
    }
    groups.push(group);
  });

  return groups;
}

export async function parseChecklistXlsx(buffer: Buffer): Promise<ParsedChecklist> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const items: ParsedChecklistItem[] = [];
  const notes: string[] = [];
  let order = 0;

  workbook.eachSheet((sheet) => {
    let groups: ColumnGroup[] = [];
    /** The category column is merged vertically, so an empty cell means "same as above". */
    let carried: (string | null)[] = [];
    /** The last banner row's cells, read per column so side-by-side blocks keep their own title. */
    let bannerCells: string[] = [];
    let headerRows = 0;

    sheet.eachRow((row) => {
      const cells: string[] = [];
      /** Where each cell's value really comes from — a merged slave reports its master's address. */
      const sources: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        cells[column - 1] = clean(cellText(cell));
        sources[column - 1] = cell.isMerged ? cell.master?.address ?? cell.address : cell.address;
      });
      for (let i = 0; i < cells.length; i += 1) cells[i] = cells[i] ?? '';

      const candidate = groupsFromHeaderRow(cells);
      if (candidate.length) {
        groups = candidate;
        carried = [];
        headerRows += 1;
        return;
      }

      // A banner row titles the block below it rather than asking anything. Counting non-empty
      // *cells* would miss it — ExcelJS hands every slave of a merge the master's text, so the row
      // looks full. What marks a banner is that every value it shows is stretched *horizontally*
      // across columns. A vertical merge (this sheet merges the category column down each block)
      // spans only one column per row, so it is correctly not a banner. This sheet also puts two
      // banners side by side on one row, which is why "exactly one value" is the wrong test.
      const spans = new Map<string, number>();
      cells.forEach((text, index) => {
        if (text) spans.set(sources[index], (spans.get(sources[index]) ?? 0) + 1);
      });
      const filled = cells.filter(Boolean).length;
      const isBanner = filled > 0 && cells.every((text, index) => !text || (spans.get(sources[index]) ?? 0) > 1);
      if (isBanner) {
        bannerCells = cells.slice();
        carried = [];
        return;
      }

      if (!groups.length) return;

      groups.forEach((group, groupIndex) => {
        const text = cells[group.text] ?? '';
        if (group.section !== null) {
          const section = cells[group.section] ?? '';
          if (section) carried[groupIndex] = section;
        }
        if (!text) return;

        // The banner only names the section when the sheet has no category column to say it.
        // Read it at this group's own columns: a row can carry one banner per side-by-side block.
        const banner =
          bannerCells[group.text] || (group.section !== null ? bannerCells[group.section] : '') || null;
        const section = carried[groupIndex] ?? banner ?? null;
        order += 1;
        items.push({
          order,
          section,
          code: null,
          text,
          guidance: (group.guidance !== null && cells[group.guidance]) || null,
          expected: (group.expected !== null && cells[group.expected]) || null,
        });
      });
    });

    notes.push(`sheet "${sheet.name}": ${headerRows} header row(s)`);
  });

  return {
    items,
    note: `Spreadsheet checklist · ${items.length} item(s) · ${notes.join('; ')}`,
  };
}

// ---------------------------------------------------------------------------
// Word checklists (SKAX / AGS)
// ---------------------------------------------------------------------------

/**
 * Word splits one visible word across several `<w:t>` runs, so runs are concatenated with **no**
 * separator — joining them with a space turns "AGS" into "A GS".
 */
const W_T = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/**
 * Runs *and* the breaks between them, in document order. A `<w:br/>` is a visible line break —
 * this document puts the Korean term on one line and its English translation on the next inside
 * one paragraph — so ignoring it would join them into "변경관리Change mgmt.".
 */
const W_RUN_OR_BREAK = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:br|cr|tab)\b[^>]*\/?>/g;

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** One paragraph: runs concatenated with no separator (a run break is mid-word), breaks as spaces. */
function paragraphText(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(W_RUN_OR_BREAK)) {
    out += match[1] === undefined ? ' ' : unescapeXml(match[1]);
  }
  return clean(out);
}

/**
 * A table cell holds whole paragraphs, and those *are* separated — a Korean term on one line and
 * its English translation on the next. Joining them like runs would give "변경관리Change mgmt.".
 */
function blockText(xml: string): string {
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g);
  if (!paragraphs) return paragraphText(xml);
  return clean(paragraphs.map(paragraphText).filter(Boolean).join(' '));
}

/** The answer box at the end of an AGS check: `■ Yes  No  N/A`, the ■ marking the chosen one. */
const ANSWER_BOX = /([■√☑☒□]?)\s*Yes\s*([■√☑☒□]?)\s*No\s*([■√☑☒□]?)\s*N\s*\/\s*A/i;
const TICKED = /[■√☑]/;
/** Boilerplate repeated under every check — not a check itself. */
const BOILERPLATE = /^※/;

/** Which box the author ticked, if any. */
function tickedAnswer(match: RegExpMatchArray): string | null {
  if (TICKED.test(match[1] ?? '')) return 'Yes';
  if (TICKED.test(match[2] ?? '')) return 'No';
  if (TICKED.test(match[3] ?? '')) return 'N/A';
  return null;
}

/** Korean prefix of a heading, so `장애/문제관리 (Incident/Problem)` matches `장애/문제관리 Incident`. */
function koreanKey(value: string): string {
  const korean = value.match(/^[^A-Za-z(（]+/);
  return clean(korean ? korean[0] : value).replace(/[\s()[\]/·]/g, '');
}

/**
 * The AGS document opens with a summary table — `구분 Area | …` over `항목 수 Items | 7 | 5 | …`.
 * It gives both the area names (so checks can be grouped) and the expected item count (so the
 * parse can be checked against the document's own arithmetic).
 */
function readAreaSummary(tables: string[][][]): { areas: string[]; expected: number | null } {
  for (const table of tables) {
    if (table.length < 2) continue;
    const [head, count] = table;
    if (!/구분|area/i.test(head[0] ?? '')) continue;
    if (!/항목\s*수|items/i.test(count[0] ?? '')) continue;
    const areas = head.slice(1).filter(Boolean);
    const numbers = count.slice(1).map((value) => Number(value.replace(/[^\d]/g, '')));
    const expected = numbers.every((n) => Number.isFinite(n) && n > 0)
      ? numbers.reduce((sum, n) => sum + n, 0)
      : null;
    return { areas, expected };
  }
  return { areas: [], expected: null };
}

export async function parseChecklistDocx(buffer: Buffer): Promise<ParsedChecklist> {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('word/document.xml');
  if (!entry) return { items: [], note: 'Not a readable Word document — word/document.xml is missing.' };

  const xml = await entry.async('string');
  const body = xml.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? xml;

  // Top-level blocks in document order: paragraphs and tables.
  const blocks = body.match(/<w:p\b[\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];

  const tables: string[][][] = [];
  for (const block of blocks) {
    if (!block.startsWith('<w:tbl')) continue;
    const rows = block.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
    tables.push(rows.map((row) => (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(blockText)));
  }

  const { areas, expected } = readAreaSummary(tables);
  const areaByKey = new Map(areas.map((area) => [koreanKey(area), area]));

  const items: ParsedChecklistItem[] = [];
  let section: string | null = null;
  let order = 0;

  for (const block of blocks) {
    if (block.startsWith('<w:tbl')) continue;
    const text = paragraphText(block);
    if (!text || BOILERPLATE.test(text)) continue;

    // A heading naming one of the management areas the summary table listed.
    const asArea = areaByKey.get(koreanKey(text));
    if (asArea && !ANSWER_BOX.test(text)) {
      section = asArea;
      continue;
    }

    const match = text.match(ANSWER_BOX);
    if (!match) continue;

    const question = clean(text.slice(0, match.index ?? 0));
    if (!question) continue;

    order += 1;
    items.push({
      order,
      section,
      code: null,
      text: question,
      guidance: clean(text.slice((match.index ?? 0) + match[0].length)) || null,
      expected: tickedAnswer(match),
    });
  }

  const parts = [`Word checklist · ${items.length} item(s) read from Yes/No/N-A paragraphs`];
  if (areas.length) parts.push(`${areas.length} management area(s): ${areas.join(', ')}`);
  if (expected !== null) {
    parts.push(
      items.length === expected
        ? `matches the document's own count of ${expected}`
        : `the document's own summary says ${expected} — please review`,
    );
  }
  parts.push(`${tables.length} table(s) kept as reference material, not as checks`);
  return { items, note: parts.join(' · ') };
}

// ---------------------------------------------------------------------------

/** Picks the strategy from the file extension. */
export async function parseChecklist(buffer: Buffer, fileName: string): Promise<ParsedChecklist> {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  if (ext === '.xlsx' || ext === '.xlsm') return parseChecklistXlsx(buffer);
  if (ext === '.docx') return parseChecklistDocx(buffer);
  return {
    items: [],
    note: `${ext || 'This file type'} cannot be parsed as a checklist — upload .xlsx or .docx. The file is stored, but no items were read.`,
  };
}
