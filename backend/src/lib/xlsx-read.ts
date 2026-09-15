/**
 * Reads the visible grid out of an `.xlsx`, sheet by sheet.
 *
 * The counterpart of `pptx-read.ts`, and it exists for the same reason: the preview of a document
 * filled from a customer's own workbook must be generated from **the file the PM is about to
 * download**, not from the fill values. The house Project Plan template is 16 sheets; showing its
 * 274 answered blanks as a list would show none of the plan.
 *
 * Text and merges only — fonts, colours, borders, images and charts are not extracted, and the
 * preview says so rather than pretending to be Excel.
 */

import ExcelJS from 'exceljs';

export interface SheetMerge {
  /** 0-based, relative to the returned `rows` grid. */
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
}

export interface WorkbookSheet {
  name: string;
  /** Row-major, already trimmed to the used range and capped — see MAX_ROWS / MAX_COLS. */
  rows: string[][];
  merges: SheetMerge[];
  /** True when the sheet was longer or wider than the cap, so the preview can say it is cut off. */
  truncated: boolean;
}

/**
 * A plan workbook can carry thousands of empty formatted rows below its content. The cap keeps a
 * preview payload to something a browser can lay out; the flag keeps it honest about the cut.
 */
const MAX_ROWS = 200;
const MAX_COLS = 30;
const MAX_CELL_CHARS = 400;

/**
 * ExcelJS *throws* on a merged slave whose master is empty, and hands every other slave the
 * master's text. The preview draws the master once via `merges`, so a slave must read as empty.
 */
function cellText(cell: ExcelJS.Cell): string {
  try {
    if (cell.isMerged && cell.master !== cell) return '';
    const value = cell.value;
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object') {
      const rich = value as { richText?: { text: string }[]; text?: string; result?: unknown };
      if (rich.richText) return rich.richText.map((run) => run.text).join('');
      if (typeof rich.text === 'string') return rich.text;
      if (rich.result !== undefined && rich.result !== null) return String(rich.result);
      return '';
    }
    return String(value);
  } catch {
    return '';
  }
}

/** "A1:D3" → the 0-based span the preview needs. */
function parseMerge(range: string): SheetMerge | null {
  const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;
  const column = (letters: string) =>
    [...letters.toUpperCase()].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0);
  const [, c1, r1, c2, r2] = match;
  const top = Number(r1) - 1;
  const left = column(c1) - 1;
  return { row: top, col: left, rowSpan: Number(r2) - top, colSpan: column(c2) - left };
}

export async function readWorkbook(buffer: Buffer): Promise<WorkbookSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  return workbook.worksheets
    .filter((sheet) => sheet.state !== 'hidden' && sheet.state !== 'veryHidden')
    .map((sheet) => {
      const rowCount = Math.min(sheet.rowCount || 0, MAX_ROWS);
      const colCount = Math.min(sheet.columnCount || 0, MAX_COLS);

      const rows: string[][] = [];
      for (let r = 1; r <= rowCount; r += 1) {
        const row = sheet.getRow(r);
        const cells: string[] = [];
        for (let c = 1; c <= colCount; c += 1) cells.push(cellText(row.getCell(c)).slice(0, MAX_CELL_CHARS));
        rows.push(cells);
      }

      // Trailing empty rows are formatting, not content — a plan sheet has hundreds of them.
      while (rows.length && rows[rows.length - 1].every((cell) => !cell.trim())) rows.pop();

      const merges = ((sheet.model as { merges?: string[] }).merges ?? [])
        .map(parseMerge)
        .filter((merge): merge is SheetMerge => Boolean(merge))
        .filter((merge) => merge.row < rows.length && merge.col < colCount)
        // Clip a merge that runs past the cap, or the preview's colspan pushes the table wider.
        .map((merge) => ({
          ...merge,
          rowSpan: Math.min(merge.rowSpan, rows.length - merge.row),
          colSpan: Math.min(merge.colSpan, colCount - merge.col),
        }));

      return {
        name: sheet.name,
        rows,
        merges,
        truncated: (sheet.rowCount || 0) > MAX_ROWS || (sheet.columnCount || 0) > MAX_COLS,
      };
    });
}
