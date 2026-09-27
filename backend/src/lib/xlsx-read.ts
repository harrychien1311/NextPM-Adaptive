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

import { readSheetCells } from './xlsx-cells';

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
 * The cap keeps a preview payload to something a browser can lay out; the flag keeps it honest
 * about the cut.
 */
const MAX_ROWS = 200;
const MAX_COLS = 30;
const MAX_CELL_CHARS = 400;

export async function readWorkbook(buffer: Buffer): Promise<WorkbookSheet[]> {
  const sheets = await readSheetCells(buffer);

  return sheets
    .filter((sheet) => !sheet.hidden)
    .map((sheet) => {
      // The used range is where values are — thousands of formatted empty rows below it are not
      // content, and the lean reader never materialised them.
      const rowCount = Math.min(sheet.maxRow, MAX_ROWS);
      const colCount = Math.min(sheet.maxCol, MAX_COLS);

      // The preview draws a merge's master once, spanning its range, so a slave must read empty even
      // where the file still stores a value under it.
      const slaves = new Set<string>();
      for (const merge of sheet.merges) {
        for (let r = merge.top; r <= Math.min(merge.bottom, rowCount); r += 1) {
          for (let c = merge.left; c <= Math.min(merge.right, colCount); c += 1) {
            if (r !== merge.top || c !== merge.left) slaves.add(`${r}:${c}`);
          }
        }
      }

      const rows: string[][] = [];
      for (let r = 1; r <= rowCount; r += 1) {
        const values = sheet.cells.get(r);
        const cells: string[] = [];
        for (let c = 1; c <= colCount; c += 1) {
          cells.push(slaves.has(`${r}:${c}`) ? '' : (values?.get(c) ?? '').slice(0, MAX_CELL_CHARS));
        }
        rows.push(cells);
      }

      const merges = sheet.merges
        .map((merge) => ({
          row: merge.top - 1,
          col: merge.left - 1,
          rowSpan: merge.bottom - merge.top + 1,
          colSpan: merge.right - merge.left + 1,
        }))
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
        truncated: sheet.maxRow > MAX_ROWS || sheet.maxCol > MAX_COLS || Boolean(sheet.skipped),
      };
    });
}
