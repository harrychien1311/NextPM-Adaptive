/**
 * Documents whose deliverable is a **table**, not prose.
 *
 * A change log, an escalation path and a work breakdown are all registers: every row is one
 * entry, and the value is in being able to sort, filter and hand the grid to someone. Writing
 * them as paragraphs produced documents nobody could use as the thing they are named after — so
 * these export as `.xlsx`, carry no narrative, and Skill 2 is asked for rows instead of sections.
 *
 * Each entry names its own columns, because these tables have nothing in common but being tables:
 * a WBS row is not shaped like an escalation step. The column list is what goes into the prompt,
 * into the spreadsheet header, and into the on-screen preview — one definition, three consumers,
 * so they cannot drift.
 *
 * `RACI Matrix` is deliberately *not* here: it predates this and keeps its own typed `raciTable`,
 * which the dashboard `.html` export also reads. Folding it in would be a bigger change than the
 * duplication costs.
 */

export interface TableDocumentSchema {
  /** Column headers, in order. Also the spreadsheet header row. */
  columns: string[];
  /** One line telling the model what a single row represents. Goes into the prompt verbatim. */
  rowMeaning: string;
}

export const TABLE_DOCUMENTS: Record<string, TableDocumentSchema> = {
  'Change & Decision Log': {
    columns: ['Ref', 'Date', 'Type', 'Item', 'Decision or change', 'Raised by', 'Decided by', 'Impact', 'Status'],
    rowMeaning:
      'one decision taken or change accepted on this project, with who raised it, who decided it, ' +
      'what it affects and whether it is open or closed. "Type" is Decision or Change.',
  },
  'Change / Escalation Flow': {
    columns: ['Step', 'Trigger', 'Raised by', 'Handled by', 'Action', 'Target response', 'Escalates to', 'Evidence'],
    rowMeaning:
      'one step of the path a change or an issue travels, in order, from first report to final ' +
      'decision — who holds it at that step, how long they have, and who it goes to if unresolved.',
  },
  'WBS & Integration Boundary': {
    columns: ['WBS ID', 'Work package', 'Deliverable', 'Owner', 'In scope', 'Out of scope / boundary', 'Depends on'],
    rowMeaning:
      'one work package, with the deliverable it produces, who owns it, and — this is the point of ' +
      'the document — exactly where its scope stops and another system or party takes over.',
  },
};

export function isTableDocument(documentName: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE_DOCUMENTS, documentName);
}

export function tableSchema(documentName: string): TableDocumentSchema | null {
  return TABLE_DOCUMENTS[documentName] ?? null;
}
