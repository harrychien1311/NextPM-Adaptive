import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { documentsApi } from '../../api/endpoints';

/**
 * Mirrors `isChartDocument` in the backend's `document-format.ts`. Kept in step with it: both
 * decide the same thing about the same document, and they must not disagree.
 */
const isChartDocument = (name: string) => /organi[sz]ation chart|org chart/i.test(name);
import type {
  DocumentExportFormat,
  DocumentGap,
  DocumentSection,
  DocumentStructuredData,
  OrgChart,
} from '../../api/types';

/**
 * What the preview needs, independent of where it came from. The Planning Studio passes a catalog
 * entry's document; the Dashboard passes one fetched by id.
 */
export interface PreviewDocument {
  /** Needed to ask the server for the rendered deck — a `.pptx` previews from the real file. */
  id: string;
  name: string;
  version: number;
  status: string;
  sections: DocumentSection[];
  gaps: DocumentGap[];
  structuredData: DocumentStructuredData | null;
  /** Only labels the download button — the server decides the real container. Word unless stated. */
  exportFormat?: DocumentExportFormat;
  /** A register's own columns, so its grid is right even before the document has been generated. */
  tableColumns?: string[] | null;
}

/** Capturing + global so `split` keeps the tokens as their own array entries. */
const GAP_SPLIT = /(\{\{gap:\d+\}\})/g;
/** Separate, non-global copy: `.test()` on a /g regex advances lastIndex between calls. */
const IS_GAP = /^\{\{gap:\d+\}\}$/;

/**
 * Renders one paragraph, turning any blank the model refused to guess into a visible marker
 * rather than leaking the raw `{{gap:N}}` token.
 */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(GAP_SPLIT).map((part, index) =>
        IS_GAP.test(part) ? (
          <mark className="gap-marker" key={index}>
            answer needed
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function Cell({ text }: { text: string }) {
  return (
    <td>
      <Prose text={text} />
    </td>
  );
}

/**
 * A read-only rendering of the planning document **in the shape of the file it downloads as**.
 *
 * The point of a preview is to show the PM what they are about to hand over, so a deck must look
 * like slides and a matrix like a spreadsheet — a page-shaped preview of a `.pptx` is a preview of
 * something that does not exist. `exportFormat` is the server's own decision (see
 * `document-format.ts`), so the preview cannot disagree with the file about which it is.
 *
 * All three shapes read from the same data the exporters read, rather than parsing a rendered
 * file in the browser, so a preview and its download cannot drift apart over a rendering
 * library's quirks. Their colours deliberately mirror `document-format.ts`.
 */
export function DocumentPreview({
  document,
  projectId,
  projectName,
  onClose,
  onDownload,
}: {
  document: PreviewDocument | null;
  projectId: string;
  projectName: string;
  onClose: () => void;
  onDownload?: () => void;
}) {
  if (!document) return null;
  const format = document.exportFormat ?? 'DOCX';

  return (
    <div className="doc-preview-overlay" role="dialog" aria-label={`${document.name} preview`}>
      <div className="doc-preview-bar">
        <div>
          <strong>{document.name}</strong>
          <small>
            v{document.version} · {document.status === 'APPROVED' ? 'PM approved · baseline' : 'AI draft · PM review required'}
          </small>
        </div>
        <div>
          {onDownload && (
            <button className="secondary" onClick={onDownload}>
              Download .{(document.exportFormat ?? 'DOCX').toLowerCase()}
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            Close preview
          </button>
        </div>
      </div>

      <div className="doc-preview-scroll" onClick={(event) => event.target === event.currentTarget && onClose()}>
        {/*
          Routed on the document, not on whether the data happens to be there: a chart generated
          before this document became a drawn chart has prose and no `orgChart`, and the honest
          thing to show is "regenerate it", not a page of prose pretending to be the deliverable.
        */}
        {isChartDocument(document.name) ? (
          <OrgChartPreview document={document} projectName={projectName} />
        ) : format === 'PPTX' ? (
          <DeckPreview document={document} projectId={projectId} projectName={projectName} />
        ) : format === 'XLSX' && document.structuredData?.templateFill ? (
          // Filled from a real workbook: the sheets are in that file and nowhere else, exactly as
          // the deck preview above reads a filled deck.
          <WorkbookPreview document={document} projectId={projectId} />
        ) : format === 'XLSX' ? (
          <SheetPreview document={document} projectName={projectName} />
        ) : (
          <PagePreview document={document} projectName={projectName} />
        )}
      </div>
    </div>
  );
}

/** The Word shape: a page, headings, tables. What `renderDocumentDocx` writes. */
function PagePreview({ document, projectName }: { document: PreviewDocument; projectName: string }) {
  const raci = document.structuredData?.raciTable ?? [];
  const risks = document.structuredData?.riskRegister ?? [];

  return (
    <>
        <article className="doc-page">
          <h1>{document.name}</h1>
          <p className="doc-meta">
            <b>{projectName}</b>
            <span>
              {' '}
              · version {document.version} · {document.status}
            </span>
          </p>
          <p className="doc-note">
            AI-drafted from PM-verified project inputs. Highlighted blanks are facts the project data did not contain.
          </p>

          {document.sections
            .filter((section) => section.included && section.content)
            .map((section) => (
              <section key={section.id}>
                <h2>{section.title}</h2>
                {(section.content ?? '').split(/\n{2,}/).map((block, index) => (
                  <p key={index}>
                    <Prose text={block.trim()} />
                  </p>
                ))}
              </section>
            ))}

          {raci.length > 0 && (
            <section>
              <h2>RACI Matrix</h2>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Responsible</th>
                    <th>Accountable</th>
                    <th>Consulted</th>
                    <th>Informed</th>
                  </tr>
                </thead>
                <tbody>
                  {raci.map((row, index) => (
                    <tr key={index}>
                      <Cell text={row.activity} />
                      <Cell text={row.responsible} />
                      <Cell text={row.accountable} />
                      <Cell text={row.consulted} />
                      <Cell text={row.informed} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {risks.length > 0 && (
            <section>
              <h2>Risk Register</h2>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>Risk</th>
                    <th>Severity</th>
                    <th>Owner</th>
                    <th>Mitigation</th>
                  </tr>
                </thead>
                <tbody>
                  {risks.map((row, index) => (
                    <tr key={index}>
                      <Cell text={row.risk} />
                      <td>{row.severity}</td>
                      <Cell text={row.owner} />
                      <Cell text={row.mitigation} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

        </article>
    </>
  );
}

/**
 * The PowerPoint shape: one card per slide, read out of the **real rendered file**.
 *
 * Not drawn from the document's sections. For a deck filled from a customer's template those
 * sections are placeholder→value pairs, and the slides themselves live only inside their file —
 * so anything built from the sections would show a handful of blanks and none of the deck. The
 * server renders the export and reads its text back, which also means the preview cannot disagree
 * with the download about what is in it.
 *
 * Text only: images, charts and exact layout are not extracted, and each card says so where it
 * matters rather than pretending to be a renderer.
 */
function DeckPreview({
  document,
  projectId,
  projectName,
}: {
  document: PreviewDocument;
  projectId: string;
  projectName: string;
}) {
  const deck = useQuery({
    queryKey: ['slides', projectId, document.id],
    queryFn: () => documentsApi.slides(projectId, document.id),
  });

  if (deck.isLoading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Rendering the deck…
      </div>
    );
  }

  if (deck.isError || !deck.data) {
    return <div className="state-block">Could not read the deck. Try downloading it instead.</div>;
  }

  const { slides, template, fileName } = deck.data;

  return (
    <div className="deck-slides">
      <p className="deck-caption">
        <b>{fileName}</b> · {slides.length} slide{slides.length === 1 ? '' : 's'} ·{' '}
        {template ? (
          <>
            filled into {template.customerKey}’s own template <b>{template.sourceFile}</b> — their layout, fonts and
            images are kept
          </>
        ) : (
          <>built for {projectName}</>
        )}
        . Text only — images and exact layout are in the file.
      </p>

      {slides.map((slide) => {
        // A bare number is the slide-number shape, not content — a real corporate template puts one
        // on most slides, and taking it as the title made slide 1 read as "1".
        const content = slide.lines.filter((line) => !/^\d{1,3}[.)]?$/.test(line));
        const [title, ...rest] = content;
        return (
          <article className="deck-slide" key={slide.number}>
            <div className="deck-slide-rule" />
            <div className="deck-slide-body">
              {title && <h2>{title}</h2>}
              <ul>
                {rest.map((line, index) => (
                  <li key={index}>
                    <Prose text={line} />
                  </li>
                ))}
              </ul>
              {!content.length && <p className="doc-note">This slide carries no text — see the file.</p>}
            </div>
            <span className="deck-slide-number">{slide.number}</span>
            {(slide.pictures > 0 || slide.hasTable) && (
              <span className="deck-slide-contains">
                {slide.pictures > 0 && `${slide.pictures} image${slide.pictures === 1 ? '' : 's'}`}
                {slide.pictures > 0 && slide.hasTable && ' · '}
                {slide.hasTable && 'table'}
              </span>
            )}
          </article>
        );
      })}

    </div>
  );
}

/**
 * The spreadsheet shape — sheet tabs, lettered columns, numbered rows. Mirrors the sheets
 * `xlsx-export.ts` writes: the matrix, the prose, and the open questions.
 */
function SheetPreview({ document, projectName }: { document: PreviewDocument; projectName: string }) {
  /**
   * Which grid this is, decided by what the document IS — `tableColumns` comes from its schema and
   * is there whether or not it has been generated. Deciding from the stored rows instead is what
   * put a RACI header on an ungenerated change log.
   */
  const isRegister = Boolean(document.tableColumns?.length);
  const register = document.structuredData?.table;
  const raci = document.structuredData?.raciTable ?? [];
  // A register carries no narrative by design, so its prose tab never appears.
  const sections = isRegister ? [] : document.sections.filter((section) => section.included && section.content);
  const [sheet, setSheet] = useState<'matrix' | 'narrative'>('matrix');

  const RACI_HEADERS = ['Activity', 'Responsible (R)', 'Accountable (A)', 'Consulted (C)', 'Informed (I)'];

  const grid = isRegister
    ? {
        label: document.name,
        columns: register?.columns ?? document.tableColumns ?? [],
        rows: register?.rows ?? [],
      }
    : {
        label: 'RACI Matrix',
        columns: RACI_HEADERS,
        rows: raci.map((row) => [row.activity, row.responsible, row.accountable, row.consulted, row.informed]),
      };

  // No gap sheet: the open questions live in the studio's own panel, not in the deliverable.
  const tabs = [
    { key: 'matrix' as const, label: grid.label, count: grid.rows.length },
    ...(sections.length ? [{ key: 'narrative' as const, label: 'Narrative', count: sections.length }] : []),
  ];

  return (
    <article className="sheet-book">
      <header className="sheet-head">
        <h1>{document.name}</h1>
        <p className="doc-meta">
          <b>{projectName}</b>
          <span>
            {' '}
            · version {document.version} · {document.status}
          </span>
        </p>
      </header>

      <div className="sheet-grid-wrap">
        {sheet === 'matrix' &&
          (grid.rows.length ? (
            <SheetGrid columns={grid.columns} rows={grid.rows} />
          ) : (
            <>
              {/* Show the real header even when empty, so the PM sees what the document will hold. */}
              {grid.columns.length > 0 && <SheetGrid columns={grid.columns} rows={[]} />}
              <p className="org-chart-empty">
                <b>No rows yet.</b> Press <b>Generate document</b> — a version produced before this document became
                a table holds prose instead, and needs generating again.
              </p>
            </>
          ))}

        {sheet === 'narrative' && (
          <table className="sheet-grid">
            <thead>
              <tr>
                <th className="sheet-corner" />
                <th className="sheet-col">A</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((section, index) => (
                <tr key={section.id}>
                  <th className="sheet-row-number">{index + 1}</th>
                  <td>
                    <strong>{section.title}</strong>
                    <br />
                    <Prose text={section.content ?? ''} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      </div>

      {/* Sheet tabs sit at the bottom, where a spreadsheet puts them. */}
      <div className="sheet-tabs">
        {tabs.map((tab) => (
          <button key={tab.key} className={sheet === tab.key ? 'active' : ''} onClick={() => setSheet(tab.key)}>
            {tab.label} <b>{tab.count}</b>
          </button>
        ))}
      </div>
    </article>
  );
}

/**
 * The workbook shape, read out of the **real rendered file** — the spreadsheet counterpart of
 * `DeckPreview`, and there for the same reason.
 *
 * A document filled from a customer's workbook has the customer's 16 sheets; its own sections are
 * placeholder → value pairs. Drawing those pairs would show the answered blanks and none of the
 * plan, so the server renders the export and reads its sheets back. Text and merges only — fonts,
 * colours, borders and charts stay in the file, and the caption says so.
 */
function WorkbookPreview({ document, projectId }: { document: PreviewDocument; projectId: string }) {
  const book = useQuery({
    queryKey: ['sheets', projectId, document.id],
    queryFn: () => documentsApi.sheets(projectId, document.id),
  });
  const [active, setActive] = useState(0);

  if (book.isLoading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Rendering the workbook…
      </div>
    );
  }
  if (book.isError || !book.data?.sheets.length) {
    return <div className="state-block">Could not read the workbook. Try downloading it instead.</div>;
  }

  const { sheets, template, fileName } = book.data;
  const sheet = sheets[Math.min(active, sheets.length - 1)];

  return (
    <article className="sheet-book">
      <header className="sheet-head">
        <h1>{document.name}</h1>
        <p className="doc-meta">
          <b>{fileName}</b>
          <span>
            {' '}
            · filled into {template.customerKey}’s own template <b>{template.sourceFile}</b> · {sheets.length} sheet
            {sheets.length === 1 ? '' : 's'} · version {document.version}
          </span>
        </p>
      </header>

      <div className="sheet-grid-wrap">
        <WorkbookGrid rows={sheet.rows} merges={sheet.merges} />
        {sheet.truncated && (
          <p className="doc-note">This sheet is longer or wider than the preview shows — the file has all of it.</p>
        )}
        {!sheet.rows.length && <p className="org-chart-empty">This sheet is empty.</p>}
      </div>

      <div className="sheet-tabs">
        {sheets.map((entry, index) => (
          <button key={entry.name} className={index === active ? 'active' : ''} onClick={() => setActive(index)}>
            {entry.name}
          </button>
        ))}
      </div>
    </article>
  );
}

/**
 * One sheet, drawn with the workbook's own merges. A merged master is drawn once spanning its
 * range and its slaves are skipped — without that a plan sheet with 346 merged ranges lays out as
 * a grid of stray repeats.
 */
function WorkbookGrid({
  rows,
  merges,
}: {
  rows: string[][];
  merges: { row: number; col: number; rowSpan: number; colSpan: number }[];
}) {
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0);

  // Cells covered by someone else's merge must not be emitted at all.
  const covered = new Set<string>();
  const master = new Map<string, { rowSpan: number; colSpan: number }>();
  for (const merge of merges) {
    master.set(`${merge.row}:${merge.col}`, { rowSpan: merge.rowSpan, colSpan: merge.colSpan });
    for (let r = merge.row; r < merge.row + merge.rowSpan; r += 1) {
      for (let c = merge.col; c < merge.col + merge.colSpan; c += 1) {
        if (r !== merge.row || c !== merge.col) covered.add(`${r}:${c}`);
      }
    }
  }

  return (
    <table className="sheet-grid">
      <thead>
        <tr>
          <th className="sheet-corner" />
          {Array.from({ length: width }, (_column, index) => (
            <th key={index} className="sheet-col">
              {String.fromCharCode(65 + (index % 26))}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            <th className="sheet-row-number">{rowIndex + 1}</th>
            {Array.from({ length: width }, (_column, colIndex) => {
              if (covered.has(`${rowIndex}:${colIndex}`)) return null;
              const span = master.get(`${rowIndex}:${colIndex}`);
              return (
                <td key={colIndex} rowSpan={span?.rowSpan} colSpan={span?.colSpan}>
                  <Prose text={row[colIndex] ?? ''} />
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The org chart, drawn.
 *
 * Not read back from the rendered file like other decks: the chart's *structure* — which
 * organisation, which team, who leads — is the content, and a flat list of box labels pulled out
 * of the slide would lose exactly that. It is drawn here from the same `orgChart` data the slide
 * renderer draws from, in the same left-to-right organisation columns, so the two agree.
 *
 * No prose, by design. The chart is the whole deliverable.
 */
function OrgChartPreview({ document, projectName }: { document: PreviewDocument; projectName: string }) {
  const chart = document.structuredData?.orgChart;
  const columns = (chart?.columns ?? []).filter((column) => column.groups.some((group) => group.nodes.length));

  return (
    <article className="org-chart-page">
      <header>
        <h1>{document.name}</h1>
        <p className="doc-meta">
          <b>{projectName}</b>
          <span>
            {' '}
            · version {document.version} ·{' '}
            {document.status === 'APPROVED' ? 'PM approved · baseline' : 'AI draft · PM review required'}
          </span>
        </p>
      </header>

      <OrgChartFigure chart={chart ?? null} />
    </article>
  );
}

/**
 * The chart itself, drawn from `orgChart` data. Shared by the full-screen preview and the Planning
 * Studio's working panel so the PM sees one chart, not two renderings of it.
 */
export function OrgChartFigure({ chart }: { chart: OrgChart | null }) {
  const columns = (chart?.columns ?? []).filter((column) => column.groups.some((group) => group.nodes.length));
  if (!columns.length) {
    return (
      <p className="org-chart-empty">
        <b>This chart has no structure yet.</b> Press <b>Generate document</b> — a chart generated before this
        document became a drawn chart holds prose instead, and needs generating again.
      </p>
    );
  }

  return (
    <div className="org-columns">
      {columns.map((column, columnIndex) => (
        <div className="org-column" key={`${column.organisation}-${columnIndex}`}>
          <div className="org-org">{column.organisation}</div>
          {column.groups
            .filter((group) => group.nodes.length)
            .map((group, groupIndex) => (
              <div className="org-group" key={`${group.name ?? 'group'}-${groupIndex}`}>
                {group.name && <div className="org-group-name">{group.name}</div>}
                {group.nodes.map((node, nodeIndex) => (
                  <div className={`org-node${node.lead ? ' lead' : ''}`} key={`${node.role}-${nodeIndex}`}>
                    <strong>{node.role}</strong>
                    <span>
                      <Prose text={node.person} />
                    </span>
                  </div>
                ))}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A spreadsheet grid: lettered columns, numbered rows, a dark header. Shared by the register
 * documents and the RACI matrix so both look like the file they download as — and so the columns
 * are always the ones the exporter wrote, never a second list that could drift from them.
 */
export function SheetGrid({ columns, rows }: { columns: string[]; rows: string[][] }) {
  return (
    <table className="sheet-grid">
      <thead>
        <tr>
          <th className="sheet-corner" />
          {columns.map((_column, index) => (
            <th key={index} className="sheet-col">
              {String.fromCharCode(65 + index)}
            </th>
          ))}
        </tr>
        <tr>
          <th className="sheet-row-number">1</th>
          {columns.map((column, index) => (
            <th key={`${column}-${index}`} className="sheet-header-cell">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            <th className="sheet-row-number">{rowIndex + 2}</th>
            {columns.map((_column, cellIndex) => (
              <Cell key={cellIndex} text={row[cellIndex] ?? ''} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

