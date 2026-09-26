/**
 * The `.xlsx` export for RACI documents.
 *
 * A RACI matrix is a grid, not prose: activities down, roles across. Rendering it as a Word table
 * gives the PM something they cannot sort, filter or paste into their own tracker, so RACI
 * documents export as a real spreadsheet instead — frozen header, autofilter, one row per
 * activity — while every other document stays a `.docx`. `documentExportFormat()` in
 * `document-format.ts` is the single place that decides which.
 *
 * Colours and the "[ answer needed ]" blank deliberately mirror `renderDocumentDocx`, so the two
 * exports of the same document look like the same document.
 */

import ExcelJS from 'exceljs';
import type { RaciRow } from '../ai/provider';
import { DOC_COLORS, GAP_LABEL, slugForFile, splitOnGaps } from './document-format';

/** ExcelJS wants 8-digit ARGB; the palette is 6-digit RGB shared with the Word export. */
const argb = (rgb: string) => `FF${rgb}`;

const RACI_HEADERS = ['Activity', 'Responsible (R)', 'Accountable (A)', 'Consulted (C)', 'Informed (I)'];
const RACI_WIDTHS = [52, 24, 24, 24, 24];

const LEGEND: [string, string][] = [
  ['R — Responsible', 'Does the work.'],
  ['A — Accountable', 'Answerable for the outcome. Exactly one per activity.'],
  ['C — Consulted', 'Gives input before the work is done. Two-way.'],
  ['I — Informed', 'Told once it is done. One-way.'],
];

export type XlsxDocument = {
  name: string;
  version: number;
  status: string;
  projectName: string;
  sections: { title: string; content: string | null; included: boolean }[];
  raciTable: RaciRow[];
  /**
   * A register document's columns, from its schema in `data/table-documents.ts`. Present whenever
   * the document *is* a register — including before it has been generated, so an ungenerated one
   * still shows its own header rather than borrowing another document's.
   */
  tableColumns?: string[] | null;
  /** The rows, once generated. */
  table?: { columns: string[]; rows: string[][] } | null;
  /** Drafted to a workbook template's outline: write one sheet per section, as the template does. */
  sectionsAsSheets?: boolean;
};

/** Writes one cell, rendering unanswered `{{gap:N}}` tokens as a highlighted blank. */
function writeCell(cell: ExcelJS.Cell, text: string) {
  const parts = splitOnGaps(text ?? '');
  if (parts.some((part) => part.gap)) {
    cell.value = {
      richText: parts.map((part) => ({
        text: part.text,
        font: part.gap
          ? { bold: true, color: { argb: argb(DOC_COLORS.gapText) }, size: 10, name: 'Calibri' }
          : { size: 10, name: 'Calibri' },
      })),
    };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(DOC_COLORS.gapBg) } };
  } else {
    cell.value = text ?? '';
    cell.font = { size: 10, name: 'Calibri' };
  }
}

/**
 * Excel does not auto-fit wrapped text, so rows would clip. Estimates how many wrapped lines the
 * widest cell needs and sizes the row to match.
 */
function fitRowHeight(row: ExcelJS.Row, values: string[], widths: number[]) {
  const lines = values.reduce((most, value, index) => {
    const width = widths[index] ?? 20;
    const wrapped = (value ?? '').split('\n').reduce((sum, line) => sum + Math.ceil((line.length || 1) / width), 0);
    return Math.max(most, wrapped);
  }, 1);
  row.height = Math.min(Math.max(lines * 13, 18), 160);
}

function bordered(cell: ExcelJS.Cell) {
  const side = { style: 'thin' as const, color: { argb: argb(DOC_COLORS.rule) } };
  cell.border = { top: side, bottom: side, left: side, right: side };
}

/** Title block at the top of a sheet: document name, project, version and status. */
function addTitleBlock(sheet: ExcelJS.Worksheet, doc: XlsxDocument, columns: number) {
  const title = sheet.addRow([doc.name.toUpperCase()]);
  sheet.mergeCells(title.number, 1, title.number, columns);
  title.getCell(1).font = { bold: true, size: 18, color: { argb: argb(DOC_COLORS.navy) }, name: 'Calibri' };
  title.height = 26;

  const meta = sheet.addRow([`${doc.projectName}   ·   version ${doc.version}   ·   ${doc.status}`]);
  sheet.mergeCells(meta.number, 1, meta.number, columns);
  meta.getCell(1).font = { size: 10, color: { argb: argb(DOC_COLORS.muted) }, name: 'Calibri' };

  const note = sheet.addRow([
    `AI-drafted from PM-verified project inputs. Highlighted "${GAP_LABEL}" cells are facts the project data did not contain.`,
  ]);
  sheet.mergeCells(note.number, 1, note.number, columns);
  note.getCell(1).font = { italic: true, size: 9, color: { argb: argb(DOC_COLORS.muted) }, name: 'Calibri' };

  sheet.addRow([]);
}

function addMatrixSheet(workbook: ExcelJS.Workbook, doc: XlsxDocument) {
  const sheet = workbook.addWorksheet('RACI Matrix', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  RACI_WIDTHS.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  addTitleBlock(sheet, doc, RACI_HEADERS.length);

  const header = sheet.addRow(RACI_HEADERS);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(DOC_COLORS.headerBg) } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    bordered(cell);
  });
  // Freeze below the header row wherever the title block happened to end.
  sheet.views = [{ state: 'frozen', ySplit: header.number }];

  if (doc.raciTable.length) {
    doc.raciTable.forEach((entry, index) => {
      const values = [entry.activity, entry.responsible, entry.accountable, entry.consulted, entry.informed].map(
        (value) => value ?? '',
      );
      const row = sheet.addRow([]);
      values.forEach((value, column) => {
        const cell = row.getCell(column + 1);
        writeCell(cell, value);
        // Zebra striping, unless writeCell already shaded the cell as a blank.
        if (index % 2 === 1 && !cell.fill) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(DOC_COLORS.zebra) } };
        }
        cell.alignment = { vertical: 'top', wrapText: true };
        bordered(cell);
      });
      fitRowHeight(row, values, RACI_WIDTHS);
    });
    sheet.autoFilter = {
      from: { row: header.number, column: 1 },
      to: { row: header.number + doc.raciTable.length, column: RACI_HEADERS.length },
    };
  } else {
    const row = sheet.addRow(['No RACI rows were produced for this document yet.']);
    sheet.mergeCells(row.number, 1, row.number, RACI_HEADERS.length);
    row.getCell(1).font = { italic: true, size: 10, color: { argb: argb(DOC_COLORS.muted) }, name: 'Calibri' };
  }

  sheet.addRow([]);
  const legendTitle = sheet.addRow(['Legend']);
  legendTitle.getCell(1).font = { bold: true, size: 11, color: { argb: argb(DOC_COLORS.blue) }, name: 'Calibri' };
  for (const [term, meaning] of LEGEND) {
    const row = sheet.addRow([term, meaning]);
    sheet.mergeCells(row.number, 2, row.number, RACI_HEADERS.length);
    row.getCell(1).font = { bold: true, size: 10, name: 'Calibri' };
    row.getCell(2).font = { size: 10, color: { argb: argb(DOC_COLORS.muted) }, name: 'Calibri' };
    row.getCell(2).alignment = { vertical: 'top', wrapText: true };
  }
}

/** The document's prose, if the model wrote any alongside the matrix. */
function addNarrativeSheet(workbook: ExcelJS.Workbook, doc: XlsxDocument) {
  const sections = doc.sections.filter((section) => section.included && section.content);
  if (!sections.length) return;

  const sheet = workbook.addWorksheet('Narrative');
  sheet.getColumn(1).width = 120;

  for (const section of sections) {
    const title = sheet.addRow([section.title]);
    title.getCell(1).font = { bold: true, size: 12, color: { argb: argb(DOC_COLORS.blue) }, name: 'Calibri' };
    title.height = 20;

    // Keep the author's paragraph breaks instead of collapsing the section into one block.
    for (const block of (section.content ?? '').split(/\n{2,}/)) {
      const text = block.trim();
      if (!text) continue;
      const row = sheet.addRow([]);
      writeCell(row.getCell(1), text);
      row.getCell(1).alignment = { vertical: 'top', wrapText: true };
      fitRowHeight(row, [text], [120]);
    }
    sheet.addRow([]);
  }
}

/**
 * A register document: one sheet holding its own grid.
 *
 * Columns come from the document's schema (`data/table-documents.ts`), so the header row here is
 * the same list the model was asked for and the preview renders — one definition, three consumers.
 */
function addRegisterSheet(workbook: ExcelJS.Workbook, doc: XlsxDocument, table: { columns: string[]; rows: string[][] }) {
  const sheet = workbook.addWorksheet(sheetName(doc.name), {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  // Wider first column for an id/step, wider last columns for prose-ish cells.
  const widths = table.columns.map((column, index) =>
    index === 0 ? 12 : Math.min(46, Math.max(18, Math.round(column.length * 1.6) + 10)),
  );
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });

  addTitleBlock(sheet, doc, table.columns.length);

  const header = sheet.addRow(table.columns);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(DOC_COLORS.headerBg) } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    bordered(cell);
  });
  sheet.views = [{ state: 'frozen', ySplit: header.number }];

  table.rows.forEach((values, index) => {
    const row = sheet.addRow([]);
    values.forEach((value, column) => {
      const cell = row.getCell(column + 1);
      writeCell(cell, value);
      if (index % 2 === 1 && !cell.fill) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(DOC_COLORS.zebra) } };
      }
      cell.alignment = { vertical: 'top', wrapText: true };
      bordered(cell);
    });
    fitRowHeight(row, values, widths);
  });

  if (table.rows.length) {
    sheet.autoFilter = {
      from: { row: header.number, column: 1 },
      to: { row: header.number + table.rows.length, column: table.columns.length },
    };
  } else {
    // An empty grid under a correct header is still confusing — say why it is empty.
    const row = sheet.addRow([
      'No rows yet. Press “Generate document” in Planning Artifacts — a version produced before ' +
        'this document became a table holds prose instead, and needs generating again.',
    ]);
    sheet.mergeCells(row.number, 1, row.number, table.columns.length);
    row.getCell(1).font = { italic: true, size: 10, color: { argb: argb(DOC_COLORS.gapText) }, name: 'Calibri' };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(DOC_COLORS.gapBg) } };
    row.getCell(1).alignment = { vertical: 'top', wrapText: true };
    row.height = 34;
  }
}

/**
 * A prose document drafted to a workbook template's outline: one sheet per section, named after it,
 * because the template's own structure is its sheets. Sheet names are made unique, since two
 * sections can shorten to the same 31 characters.
 */
function addSectionSheets(workbook: ExcelJS.Workbook, doc: XlsxDocument) {
  const sections = doc.sections.filter((section) => section.included && section.content);
  const used = new Set<string>();
  for (const section of sections) {
    let name = sheetName(section.title);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${sheetName(section.title).slice(0, 27)} (${n})`;
    used.add(name.toLowerCase());

    const sheet = workbook.addWorksheet(name);
    sheet.getColumn(1).width = 120;
    const title = sheet.addRow([section.title]);
    title.getCell(1).font = { bold: true, size: 12, color: { argb: argb(DOC_COLORS.blue) }, name: 'Calibri' };
    title.height = 20;
    for (const block of (section.content ?? '').split(/\n{2,}/)) {
      const text = block.trim();
      if (!text) continue;
      const row = sheet.addRow([]);
      writeCell(row.getCell(1), text);
      row.getCell(1).alignment = { vertical: 'top', wrapText: true };
      fitRowHeight(row, [text], [120]);
    }
  }
  if (!sections.length) workbook.addWorksheet(sheetName(doc.name));
}

/** Excel sheet names cap at 31 characters and reject `[]:*?/\`. */
function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Sheet1';
}

export async function buildDocumentXlsx(doc: XlsxDocument): Promise<{ fileName: string; buffer: Buffer }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'NEXTPLAN AI';
  workbook.created = new Date();

  /**
   * Decided by what the document *is*, never by what data happens to be present.
   *
   * The earlier version fell back to the RACI sheet whenever rows were missing. That was safe
   * while RACI was the only spreadsheet; once registers became spreadsheets too it put a "RACI
   * Matrix" sheet — and a narrative sheet — into a change log that simply had not been
   * regenerated yet. A document must not borrow another document's shape to fill a gap in itself.
   */
  // Either field alone is enough to say "this is a register": the schema columns (present even
  // before generation) or the generated table's own. Requiring both would make it possible to
  // pass a real table and still get a RACI workbook, which is exactly the silent wrong-shape
  // failure this branch was rewritten to remove.
  const columns = doc.tableColumns?.length ? doc.tableColumns : doc.table?.columns;
  if (columns?.length) {
    addRegisterSheet(workbook, doc, { columns, rows: doc.table?.rows ?? [] });
  } else if (doc.sectionsAsSheets && !doc.raciTable.length) {
    addSectionSheets(workbook, doc);
  } else {
    addMatrixSheet(workbook, doc);
    addNarrativeSheet(workbook, doc);
  }

  // No "PM confirmation needed" sheet. The open questions are a working aid for the PM and belong
  // in the app, not in a workbook that gets sent on — the blanks are already visible in the cells
  // they belong to, which is where a reader needs to see them.

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { fileName: `${slugForFile(doc.name)}-v${doc.version}.xlsx`, buffer };
}
