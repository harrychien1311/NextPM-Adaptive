import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { DocumentStatus, ManagementDomain, Prisma, Requirement } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/http-error';
import {
  fillTemplatePlaceholders,
  generateDocument,
  generateGovernanceArtifact,
  type DocumentGap,
  type DocumentTable,
  type GenerationOutput,
  type OrgChart,
  type RaciRow,
  type RiskRow,
} from '../ai/provider';
import { tableSchema } from '../../data/table-documents';
import { buildOrgChartDeck } from '../../lib/pptx-orgchart';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ALIAS, matchCustomer } from '../../lib/customer-match';
import { fillPptxTemplate } from '../../lib/pptx-fill';
import { fillXlsxTemplate } from '../../lib/xlsx-fill';
import { buildDeck, fitWithin } from '../../lib/pptx-build';
import { readDeckText } from '../../lib/pptx-read';
import { readWorkbook } from '../../lib/xlsx-read';

/**
 * The catalog documents the last analysis said this project is missing.
 *
 * Lives here rather than in `rules.service` on purpose. `rules.service` imports this module for
 * `syncDocumentsWithPack`, and importing back would make the one module cycle this codebase
 * deliberately does not have. Nothing is lost by it: this only reads the stored snapshot, and the
 * consumer is the catalog right below.
 *
 * Returns null when no analysis has run, or when it tied no gap to a catalog name — the Studio
 * reads that as "no filter", which is the right fallback. Hiding everything because the model named
 * nothing would leave the PM unable to generate anything at all.
 *
 * The kickoff deck is always in the list: it is the meeting that starts the project, not a document
 * that might happen to be missing.
 */
export async function gapDocumentNames(projectId: string): Promise<string[] | null> {
  const evaluation = await prisma.aiApproachSuggestion.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { planningGaps: true },
  });
  if (!evaluation) return null;

  const gaps = (evaluation.planningGaps as unknown as { documentName?: string | null }[]) ?? [];
  const named = gaps.map((gap) => gap.documentName?.trim()).filter((name): name is string => Boolean(name));
  if (!named.length) return null;

  return [...new Set([...named, KICKOFF_DECK])];
}
import {
  MIN_PLACEHOLDERS_TO_FILL,
  fillabilityNote,
  type TemplatePlaceholder,
} from '../../lib/pptx-template';
import { env } from '../../config/env';
import { logEvent } from '../audit/audit.service';
import { DELIVERY_TEMPLATE, KICKOFF_DECK } from '../../data/document-catalog';
import { artifactGuidance, governanceModelMeta, isGovernanceArtifact } from '../../data/governance-models';
import {
  DOC_COLORS,
  GAP_LABEL,
  documentExportFormat,
  isChartDocument,
  isStructureOnlyDocument,
  readGaps,
  slugForFile,
  splitOnGaps,
} from './document-format';
import { buildDocumentXlsx } from './xlsx-export';
import { markAssessmentStale, reassessAfterApproval } from '../checklist/checklist.service';

export { documentExportFormat, readGaps } from './document-format';

/**
 * What `PlanningDocument.structuredData` can hold. `templateFill` marks a document that was
 * produced by filling a customer's own file rather than by drafting prose — the sections then hold
 * placeholder → value pairs, and the export fills that file instead of building a new one.
 */
export interface DocumentStructuredData {
  raciTable?: RaciRow[];
  riskRegister?: RiskRow[];
  /** The whole deliverable for an Organization Chart — drawn, never described. */
  orgChart?: OrgChart;
  /** The whole deliverable for a register document — see data/table-documents.ts. */
  table?: DocumentTable;
  templateFill?: {
    templateId: string;
    customerKey: string;
    documentType: string;
    fileType: string;
    sourceFile: string;
  };
}

const readStructured = (value: unknown): DocumentStructuredData | null =>
  (value ?? null) as DocumentStructuredData | null;

/**
 * Forces a returned table onto the schema it was asked for.
 *
 * The columns come from `data/table-documents.ts`, never from the model: it is asked to echo them
 * back, and a model that renames, reorders or drops one would otherwise silently reshape the
 * spreadsheet and the preview. Rows are padded or trimmed to the column count for the same reason
 * — a ragged grid is a broken file, and a short row is better rendered as an empty cell than as a
 * column shifted one place left.
 */
function normalizeTable(documentName: string, table: DocumentTable | undefined): DocumentTable | undefined {
  const schema = tableSchema(documentName);
  if (!schema || !table?.rows?.length) return undefined;

  const width = schema.columns.length;
  return {
    columns: schema.columns,
    rows: table.rows
      .filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim()))
      .map((row) => Array.from({ length: width }, (_cell, index) => String(row[index] ?? '').trim())),
  };
}

interface ResolvedTemplate {
  id: string;
  customerKey: string;
  customerName: string;
  documentType: string;
  fileType: 'DOCX' | 'XLSX' | 'PPTX';
  sourceFile: string;
  storageKey: string;
  placeholders: TemplatePlaceholder[];
  usableForFill: boolean;
  fillNote: string;
  /** True when this came from the house default rather than from the project's own customer. */
  house: boolean;
}

/**
 * Every active template that applies to this project, keyed by the document name it fills.
 *
 * Two layers, and the order between them is the whole point. The **house default** — the customer
 * holding the `*` alias — supplies the templates every project uses whatever the customer, which is
 * how the Project Plan workbook reaches an SK project and an LG one alike. The project's **own**
 * customer is then laid on top, so SKAX's kickoff deck beats the house kickoff deck. A customer who
 * later uploads their own Project Plan template overrides the house one automatically, with no code
 * change here.
 *
 * An empty map is a normal case, not a failure: a document with no template anywhere gets the
 * ordinary drafted document. Resolution goes through the free-text customer name, the same alias
 * matching the checklist uses.
 */
async function customerTemplatesForProject(projectId: string) {
  const resolved = new Map<string, ResolvedTemplate>();

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return resolved;

  const customers = await prisma.customer.findMany({
    where: { active: true },
    include: { templates: { where: { active: true } } },
  });

  // No early return on an empty Customer field: the library's house-default customer is meant to
  // claim exactly that case, so the decision belongs to `matchCustomer` and nowhere else.
  const match = matchCustomer(project.customer, customers);
  if (!match) return resolved;

  const house = customers.find((customer) => customer.aliases.some((alias) => alias.trim() === DEFAULT_ALIAS));

  const add = (
    customer: { key: string; name: string },
    templates: (typeof customers)[number]['templates'],
    fromHouse: boolean,
  ) => {
    for (const template of templates) {
      const placeholders = (template.placeholders ?? []) as unknown as TemplatePlaceholder[];
      resolved.set(template.documentType, {
        id: template.id,
        customerKey: customer.key,
        customerName: customer.name,
        documentType: template.documentType,
        fileType: template.fileType as 'DOCX' | 'XLSX' | 'PPTX',
        sourceFile: template.sourceFile,
        storageKey: template.storageKey,
        placeholders,
        // A template with almost no blanks is an outline deck, not a fill-in-the-blank one.
        usableForFill: placeholders.length >= MIN_PLACEHOLDERS_TO_FILL,
        fillNote: fillabilityNote(placeholders.length),
        house: fromHouse,
      });
    }
  };

  if (house && house.id !== match.customer.id) add(house, house.templates, true);
  add(match.customer, match.customer.templates, house?.id === match.customer.id);

  return resolved;
}

/**
 * The template that will actually be filled for one named document, or null.
 *
 * Returns null for a template with too few blanks. That is not a failure to find one — it is the
 * deliberate refusal described in `MIN_PLACEHOLDERS_TO_FILL`: filling an outline deck would ship
 * its example content under this project's name, so the neutral deck is the honest output and the
 * catalog explains why.
 */
async function customerTemplateForProject(projectId: string, documentName: string) {
  const template = (await customerTemplatesForProject(projectId)).get(documentName) ?? null;
  return template?.usableForFill ? template : null;
}

/**
 * Text from the project's other documents, so a kickoff deck names the same people and dates the
 * charter does. Capped hard — this is context for consistency, not a second source of truth.
 */
async function relatedDocumentExcerpts(projectId: string, excludeDocumentId: string) {
  const documents = await prisma.planningDocument.findMany({
    where: {
      projectId,
      id: { not: excludeDocumentId },
      status: { in: [DocumentStatus.PM_REVIEW, DocumentStatus.APPROVED] },
    },
    include: { sections: { orderBy: { order: 'asc' } } },
    orderBy: { approvedAt: 'desc' },
    take: 4,
  });

  return documents.map((document) => ({
    name: document.name,
    excerpt: document.sections
      .filter((section) => section.included && section.content)
      .map((section) => `${section.title}: ${section.content}`)
      .join('\n')
      .slice(0, 1_500),
  }));
}

/**
 * After the PM confirms a governance model, every document in the type's catalog is
 * provisioned as NOT_GENERATED. Document existence no longer depends on which model was
 * chosen — only each document's internal structure does (see generateDraft below).
 */
export async function syncDocumentsWithPack(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const definitions = await prisma.documentDefinition.findMany({ where: { projectType: project.type } });

  const existing = await prisma.planningDocument.findMany({ where: { projectId } });
  const existingIds = new Set(existing.map((doc) => doc.definitionId));

  const created = await Promise.all(
    definitions
      .filter((definition) => !existingIds.has(definition.id))
      .map((definition) =>
        prisma.planningDocument.create({
          data: {
            projectId,
            definitionId: definition.id,
            name: definition.name,
            domain: definition.domain,
            requirement: definition.requirement,
            status: DocumentStatus.NOT_GENERATED,
          },
        }),
      ),
  );

  return { provisioned: created.length, total: definitions.length };
}

export async function catalogForProject(projectId: string, domain?: ManagementDomain) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const definitions = await prisma.documentDefinition.findMany({
    where: { projectType: project.type, ...(domain ? { domain } : {}) },
    orderBy: [{ domain: 'asc' }, { order: 'asc' }],
  });

  const documents = await prisma.planningDocument.findMany({
    where: { projectId },
    include: { sections: { orderBy: { order: 'asc' } } },
  });
  const byDefinition = new Map(documents.map((doc) => [doc.definitionId, doc]));

  // Which documents this project's customer has a template for — those export as the customer's
  // own file type, whatever the name-based rule would otherwise say.
  const templates = await customerTemplatesForProject(projectId);

  /**
   * The documents the last analysis said this project is missing. Null when no analysis has run or
   * it tied no gap to a catalog name — the Studio then shows the whole catalog, which is the right
   * fallback: hiding everything because the model named nothing would leave the PM with no way to
   * generate anything at all.
   */
  const gapNames = await gapDocumentNames(projectId);

  return definitions.map((definition) => ({
    definitionId: definition.id,
    name: definition.name,
    domain: definition.domain,
    requirement: definition.requirement,
    conditionKey: definition.conditionKey,
    /** Which real file this document downloads as. */
    exportFormat: templates.get(definition.name)?.fileType ?? documentExportFormat(definition.name),
    /** Set when this document is produced by filling the customer's own file, for the UI to say so. */
    customerTemplate: templates.get(definition.name) ?? null,
    /** A register's own columns, so the grid shows the right header even before generation. */
    tableColumns: tableSchema(definition.name)?.columns ?? null,
    /**
     * True when the analysis named this document as a planning gap. `null` for every entry when no
     * analysis has tied a gap to a document, which the Studio reads as "no filter to apply".
     */
    inPlanningGap: gapNames ? gapNames.includes(definition.name) : null,
    document: byDefinition.get(definition.id)
      ? {
          id: byDefinition.get(definition.id)!.id,
          status: byDefinition.get(definition.id)!.status,
          version: byDefinition.get(definition.id)!.version,
          coverage: byDefinition.get(definition.id)!.coverage,
          sections: byDefinition.get(definition.id)!.sections,
          /** Open "PM confirmation needed" items — token + question + the PM's answer, if given. */
          gaps: readGaps(byDefinition.get(definition.id)!.pmQuestions),
          /** RACI / risk rows, so the on-screen preview shows the same tables as the .docx. */
          structuredData: byDefinition.get(definition.id)!.structuredData,
          generatedAt: byDefinition.get(definition.id)!.generatedAt,
          approvedAt: byDefinition.get(definition.id)!.approvedAt,
        }
      : null,
  }));
}

/** Domain tab counts for the planning studio. */
export async function domainSummary(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');
  const grouped = await prisma.documentDefinition.groupBy({
    by: ['domain'],
    where: { projectType: project.type },
    _count: { _all: true },
  });
  const order: ManagementDomain[] = ['GOVERNANCE', 'SCOPE', 'SCHEDULE', 'FINANCE', 'STAKEHOLDERS', 'RESOURCES', 'RISK'];
  return order.map((domain) => ({
    domain,
    count: grouped.find((row) => row.domain === domain)?._count._all ?? 0,
  }));
}

/**
 * Selects a template and writes the generation contract (checked sections).
 * Called before generation so the PM controls structure first.
 */
/**
 * Generates one planning document from the catalog entry the PM picked.
 *
 * There is no template and no section contract any more: the model decides the structure from the
 * document type, the project type and the confirmed governance model, and returns the sections it
 * wrote. Whatever it could not source from the project data comes back as a gap — a token left in
 * the prose plus the question to ask — never as an invented fact.
 */
export async function generateDocumentForDefinition(params: {
  projectId: string;
  definitionId: string;
  actorId: string;
}) {
  const { projectId, definitionId, actorId } = params;
  const definition = await prisma.documentDefinition.findUnique({ where: { id: definitionId } });
  if (!definition) throw notFound('Document definition not found');

  const existing = await prisma.planningDocument.upsert({
    where: { projectId_definitionId: { projectId, definitionId } },
    create: {
      projectId,
      definitionId,
      name: definition.name,
      domain: definition.domain,
      requirement: definition.requirement,
    },
    update: {},
  });

  return generateDraft({ projectId, documentId: existing.id, actorId });
}

/** The model owns the structure; this writes whatever it returned. AI drafts, PM approves. */
export async function generateDraft(params: { projectId: string; documentId: string; actorId: string }) {
  const { projectId, documentId, actorId } = params;
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, project: true, definition: true },
  });
  if (!document) throw notFound('Planning document not found');
  if (document.status === DocumentStatus.APPROVED) {
    throw conflict('Approved documents are versioned — create a new version before regenerating');
  }

  const blocking = await prisma.actionItem.findFirst({
    where: { projectId, status: 'OPEN', blocksDocument: document.name, priority: 'REQUIRED' },
  });
  if (blocking) {
    throw badRequest(`Resolve "${blocking.title}" before generating ${document.name}`, { actionItemId: blocking.id });
  }

  const decision = await prisma.approachDecision.findFirst({ where: { projectId, active: true } });
  if (!decision) throw badRequest('Confirm the governance model before generating planning outputs');

  const evaluation = decision.evaluationId
    ? await prisma.aiApproachSuggestion.findUnique({ where: { id: decision.evaluationId } })
    : await prisma.aiApproachSuggestion.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  const reasons = ((evaluation?.reasons ?? []) as unknown as string[]) ?? [];

  const verified = await prisma.projectInputValue.findMany({
    where: { projectId, verified: true, NOT: { value: null } },
    include: { definition: true },
  });

  await prisma.planningDocument.update({ where: { id: documentId }, data: { status: DocumentStatus.GENERATING } });

  const verifiedInputs = verified.map((value) => ({ label: value.definition.label, value: value.value! }));

  const generationContext = {
    projectName: document.project.name,
    projectType: document.project.type,
    approach: decision.approach,
    rigor: decision.rigor,
    documentName: document.name,
    verifiedInputs,
    reasons,
  };

  let output: GenerationOutput;
  let structuredData: DocumentStructuredData | null = null;

  const templateForDocument = await customerTemplateForProject(projectId, document.name);

  if (templateForDocument) {
    // The customer's own file is the document. Skill 2c fills its blanks instead of writing
    // prose, and each placeholder is stored as one section so everything downstream — preview,
    // "Edit content", the gap panel, "Fill out the document" — keeps working unchanged.
    const fill = await fillTemplatePlaceholders({
      ...generationContext,
      customerName: templateForDocument.customerName,
      documentType: templateForDocument.documentType,
      relatedDocuments: await relatedDocumentExcerpts(projectId, documentId),
      placeholders: templateForDocument.placeholders.map((placeholder) => ({
        token: placeholder.token,
        occurrences: placeholder.occurrences,
        locations: placeholder.locations,
      })),
    });

    output = {
      // The placeholder token is the section title on purpose: the PM sees exactly which blank in
      // the customer's deck they are editing, and the export can map a section straight back to it.
      sections: fill.values.map((value) => ({ title: value.token, content: value.value })),
      gaps: fill.gaps,
      unresolved: fill.unresolved,
      provider: fill.provider,
    };
    structuredData = {
      templateFill: {
        templateId: templateForDocument.id,
        customerKey: templateForDocument.customerKey,
        documentType: templateForDocument.documentType,
        fileType: templateForDocument.fileType,
        sourceFile: templateForDocument.sourceFile,
      },
    };
  } else if (isGovernanceArtifact(document.name)) {
    const artifactOutput = await generateGovernanceArtifact({
      ...generationContext,
      artifactName: document.name,
      structureGuidance: artifactGuidance(document.name, decision.approach),
    });
    output = artifactOutput;
    if (
      artifactOutput.raciTable ||
      artifactOutput.riskRegister ||
      artifactOutput.orgChart ||
      artifactOutput.table
    ) {
      structuredData = {
        raciTable: artifactOutput.raciTable,
        riskRegister: artifactOutput.riskRegister,
        orgChart: artifactOutput.orgChart,
        table: normalizeTable(document.name, artifactOutput.table),
      };
    }
  } else {
    const documentOutput = await generateDocument(generationContext);
    output = documentOutput;
    // A catalog document outside the six artifacts can still be a RACI matrix (SM's
    // "Support Organization & RACI") or a register (the change log, the WBS), and its .xlsx
    // export needs those rows.
    if (documentOutput.raciTable || documentOutput.riskRegister || documentOutput.table) {
      structuredData = {
        raciTable: documentOutput.raciTable,
        riskRegister: documentOutput.riskRegister,
        table: normalizeTable(document.name, documentOutput.table),
      };
    }
  }

  // A chart or a register IS the document. Anything the model wrote alongside it is the noise the
  // PM asked not to receive, and dropping it in one place means the export, the preview and the
  // studio panel cannot disagree about whether prose exists.
  if (isStructureOnlyDocument(document.name)) output = { ...output, sections: [] };

  // The model's structure replaces whatever was there — a regeneration may legitimately return a
  // different set of sections.
  await prisma.documentSection.deleteMany({ where: { documentId } });
  await prisma.documentSection.createMany({
    data: output.sections.map((section, index) => ({
      documentId,
      title: section.title,
      content: section.content,
      required: false,
      included: true,
      custom: false,
      order: index,
    })),
  });

  await prisma.planningDocument.update({
    where: { id: documentId },
    data: {
      status: DocumentStatus.PM_REVIEW,
      generatedAt: new Date(),
      coverage: 100,
      // Holds DocumentGap objects ({ token, question, answer }) — the token is what
      // "Fill out the document" substitutes the answer for.
      pmQuestions: output.gaps as unknown as Prisma.InputJsonValue,
      structuredData: structuredData ? (structuredData as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
      sourceTrace: {
        verifiedInputs: verified.length,
        reasons,
        confidence: evaluation?.confidence ?? null,
        approach: decision.approach,
        unresolved: output.unresolved,
        aiProvider: output.provider,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await logEvent({
    projectId,
    actorId,
    actorType: 'AGENT',
    type: 'DOCUMENT_GENERATED',
    title: `${document.name} generated`,
    detail: `${output.sections.length} sections · ${output.gaps.length} gap(s) for PM · produced by ${output.provider}`,
    payload: { documentId, unresolved: output.unresolved, provider: output.provider },
  });

  return prisma.planningDocument.findUnique({
    where: { id: documentId },
    include: { sections: { orderBy: { order: 'asc' } } },
  });
}

/** PM edits the draft in place — titles and body text, add or remove sections. */
export async function updateDocumentSections(params: {
  projectId: string;
  documentId: string;
  sections: { title: string; content: string }[];
  actorId: string;
}) {
  const { projectId, documentId, sections, actorId } = params;
  const document = await prisma.planningDocument.findFirst({ where: { id: documentId, projectId } });
  if (!document) throw notFound('Planning document not found');
  if (document.status === DocumentStatus.APPROVED) {
    throw conflict('Approved documents are locked — create a new version before editing');
  }

  await prisma.documentSection.deleteMany({ where: { documentId } });
  await prisma.documentSection.createMany({
    data: sections.map((section, index) => ({
      documentId,
      title: section.title,
      content: section.content,
      required: false,
      included: true,
      custom: true,
      order: index,
    })),
  });

  await logEvent({
    projectId,
    actorId,
    type: 'DOCUMENT_EDITED',
    title: `${document.name} edited by PM`,
    detail: `${sections.length} sections saved`,
  });

  return prisma.planningDocument.findUnique({
    where: { id: documentId },
    include: { sections: { orderBy: { order: 'asc' } } },
  });
}

/** Records the PM's answer to one gap. Nothing is written into the document until "fill". */
export async function answerDocumentGap(params: {
  projectId: string;
  documentId: string;
  token: string;
  answer: string;
}) {
  const { projectId, documentId, token, answer } = params;
  const document = await prisma.planningDocument.findFirst({ where: { id: documentId, projectId } });
  if (!document) throw notFound('Planning document not found');

  const gaps = readGaps(document.pmQuestions);
  const target = gaps.find((gap) => gap.token === token);
  if (!target) throw notFound('That question is not open on this document');
  target.answer = answer;

  return prisma.planningDocument.update({
    where: { id: documentId },
    data: { pmQuestions: gaps as unknown as Prisma.InputJsonValue },
    include: { sections: { orderBy: { order: 'asc' } } },
  });
}

/**
 * Substitutes every answered gap's token with its answer, across section text and the structured
 * RACI / risk tables. Plain string replacement on purpose: the PM's wording reaches the document
 * exactly as typed, and nothing they did not ask about is rewritten.
 */
export async function fillDocumentGaps(params: { projectId: string; documentId: string; actorId: string }) {
  const { projectId, documentId, actorId } = params;
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } } },
  });
  if (!document) throw notFound('Planning document not found');
  if (document.status === DocumentStatus.APPROVED) {
    throw conflict('Approved documents are locked — create a new version before editing');
  }

  const gaps = readGaps(document.pmQuestions);
  const answered = gaps.filter((gap) => gap.answer?.trim());
  if (!answered.length) throw badRequest('Answer at least one open question before filling the document');

  const substitute = (text: string) =>
    answered.reduce((current, gap) => current.split(gap.token).join(gap.answer!.trim()), text);

  await prisma.$transaction(
    document.sections.map((section) =>
      prisma.documentSection.update({
        where: { id: section.id },
        data: { content: section.content ? substitute(section.content) : section.content },
      }),
    ),
  );

  const structured = readStructured(document.structuredData);
  const nextStructured = structured
    ? {
        // A register document's answers live in its cells, so they have to be substituted there
        // too — otherwise "Fill out the document" would appear to do nothing on a table.
        table: structured.table
          ? { columns: structured.table.columns, rows: structured.table.rows.map((row) => row.map(substitute)) }
          : undefined,
        orgChart: structured.orgChart
          ? {
              columns: structured.orgChart.columns.map((column) => ({
                organisation: substitute(column.organisation),
                groups: column.groups.map((group) => ({
                  name: group.name,
                  nodes: group.nodes.map((node) => ({ ...node, person: substitute(node.person) })),
                })),
              })),
            }
          : undefined,
        raciTable: structured.raciTable?.map((row) => ({
          activity: substitute(row.activity),
          responsible: substitute(row.responsible),
          accountable: substitute(row.accountable),
          consulted: substitute(row.consulted),
          informed: substitute(row.informed),
        })),
        riskRegister: structured.riskRegister?.map((row) => ({
          risk: substitute(row.risk),
          severity: row.severity,
          owner: substitute(row.owner),
          mitigation: substitute(row.mitigation),
        })),
      }
    : null;

  // A filled gap is closed: it is no longer missing from the document.
  const remaining = gaps.filter((gap) => !gap.answer?.trim());

  await prisma.planningDocument.update({
    where: { id: documentId },
    data: {
      pmQuestions: remaining as unknown as Prisma.InputJsonValue,
      structuredData: nextStructured ? (nextStructured as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    },
  });

  await logEvent({
    projectId,
    actorId,
    type: 'DOCUMENT_GAPS_FILLED',
    title: `${answered.length} PM answer(s) written into ${document.name}`,
    detail: remaining.length ? `${remaining.length} question(s) still open` : 'No open questions left',
  });

  return prisma.planningDocument.findUnique({
    where: { id: documentId },
    include: { sections: { orderBy: { order: 'asc' } } },
  });
}

/** PM approval — only after this can content enter the exported baseline. */
export async function approveDocument(params: { projectId: string; documentId: string; actorId: string }) {
  const { projectId, documentId, actorId } = params;
  const document = await prisma.planningDocument.findFirst({ where: { id: documentId, projectId } });
  if (!document) throw notFound('Planning document not found');
  if (document.status !== DocumentStatus.PM_REVIEW) {
    throw badRequest('Only documents in PM review can be approved');
  }

  const updated = await prisma.planningDocument.update({
    where: { id: documentId },
    data: { status: DocumentStatus.APPROVED, approvedById: actorId, approvedAt: new Date() },
  });

  await logEvent({
    projectId,
    actorId,
    actorType: 'PM',
    type: 'DOCUMENT_APPROVED',
    title: `${document.name} approved`,
    detail: 'This version can now enter the approved planning baseline.',
    payload: { documentId },
  });

  // An approved document is new evidence, so the customer-checklist readiness may have moved.
  // Mark it out of date synchronously — the PM must never see a score that quietly no longer
  // reflects the project — then re-assess in the background, because approval must not wait on
  // (or fail because of) a model call. The re-run only looks at items that are not already MET:
  // an approval can add evidence, never remove it.
  await markAssessmentStale(projectId);
  void reassessAfterApproval(projectId, actorId).catch((error) => {
    // A failure is recorded on the assessment row (runState ERROR) and surfaced in the UI.
    console.error('[checklist] background re-assessment failed for project', projectId, error);
  });

  return updated;
}

/**
 * The slides of the deck this document downloads as — read out of the real file.
 *
 * The preview is generated from the export itself rather than from the data behind it, because
 * for a document filled from a customer's template the file is *their* 30-slide deck and the fill
 * values alone would show a handful of blanks and none of the deck. Rendering the export costs
 * milliseconds and no model call, and it guarantees preview and download cannot disagree.
 */
export async function documentSlides(projectId: string, documentId: string) {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    select: { name: true, structuredData: true },
  });
  if (!document) throw notFound('Planning document not found');

  const fill = readStructured(document.structuredData)?.templateFill;
  // The template's own file type decides, not the fact that a template exists: a document filled
  // from a customer's *workbook* downloads as a workbook and has no slides to read.
  const format = fill?.fileType ?? documentExportFormat(document.name);
  if (format !== 'PPTX') throw badRequest('This document does not download as a deck.');

  const { buffer, fileName } = await renderDocumentExport(projectId, documentId);
  return {
    fileName,
    /** Null when the deck is built by the app rather than filled from a customer's file. */
    template: fill ? { customerKey: fill.customerKey, sourceFile: fill.sourceFile } : null,
    slides: await readDeckText(buffer),
  };
}

/**
 * The sheets of the workbook this document downloads as — read out of the real file, for the same
 * reason `documentSlides` reads the real deck. Only a document filled from a workbook template
 * needs this: a register's grid is its own `structuredData` and the preview already has it.
 */
export async function documentSheets(projectId: string, documentId: string) {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    select: { name: true, structuredData: true },
  });
  if (!document) throw notFound('Planning document not found');

  const fill = readStructured(document.structuredData)?.templateFill;
  if (fill?.fileType !== 'XLSX') throw badRequest('This document is not filled from a workbook template.');

  const { buffer, fileName } = await renderDocumentExport(projectId, documentId);
  return {
    fileName,
    template: { customerKey: fill.customerKey, sourceFile: fill.sourceFile },
    sheets: await readWorkbook(buffer),
  };
}

/** One generated document, shaped for the preview panel (which the dashboard also opens). */
export async function documentDetail(projectId: string, documentId: string) {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: {
      sections: { orderBy: { order: 'asc' } },
      approvedBy: { select: { id: true, name: true, initials: true } },
    },
  });
  if (!document) throw notFound('Planning document not found');
  const fill = readStructured(document.structuredData)?.templateFill;
  return {
    ...document,
    gaps: readGaps(document.pmQuestions),
    // A document generated from a customer template downloads as that customer's file type.
    exportFormat: (fill?.fileType as 'DOCX' | 'XLSX' | 'PPTX' | undefined) ?? documentExportFormat(document.name),
    templateFill: fill ?? null,
    tableColumns: tableSchema(document.name)?.columns ?? null,
  };
}

/** Template fit panel: why this template is recommended for this project. */
export async function templateFit(projectId: string, definitionId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');
  const [decision, evaluation, definition] = await Promise.all([
    prisma.approachDecision.findFirst({ where: { projectId, active: true } }),
    prisma.aiApproachSuggestion.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    prisma.documentDefinition.findUnique({ where: { id: definitionId }, include: { templates: true } }),
  ]);

  const reasons = ((evaluation?.reasons ?? []) as unknown as string[]) ?? [];
  const recommended = definition?.templates.find((t) => t.recommended) ?? definition?.templates[0];
  const approach = decision?.approach ?? evaluation?.recommendedApproach ?? null;

  return {
    fitScore: recommended?.fitScore ?? 80,
    reasons: reasons.slice(0, 4),
    controls: {
      projectType: project.type,
      approach,
      rigor: decision?.rigor ?? (approach ? governanceModelMeta(approach).rigor : null),
    },
    deliveryTemplate: DELIVERY_TEMPLATE[project.type],
    disclaimer: 'These are product templates mapped to PMBOK practices — not official PMI forms.',
  };
}

/** Export policy: approved documents only. Drafts and TBD values are excluded. */
export async function createExport(params: { projectId: string; format: string; actorId: string }) {
  const approved = await prisma.planningDocument.findMany({
    where: { projectId: params.projectId, status: DocumentStatus.APPROVED },
    include: { sections: { where: { included: true }, orderBy: { order: 'asc' } } },
  });
  if (!approved.length) throw badRequest('No approved documents yet — approve at least one output before exporting');

  const job = await prisma.exportJob.create({
    data: { projectId: params.projectId, format: params.format, status: 'READY' },
  });

  await logEvent({
    projectId: params.projectId,
    actorId: params.actorId,
    actorType: 'PM',
    type: 'BASELINE_EXPORTED',
    title: `Approved baseline exported (${params.format})`,
    detail: `${approved.length} approved documents · drafts and unconfirmed AI content excluded`,
    payload: { jobId: job.id },
  });

  return {
    job,
    documents: approved.map((doc) => ({
      name: doc.name,
      domain: doc.domain,
      requirement: doc.requirement as Requirement,
      sections: doc.sections.map((section) => ({ title: section.title, content: section.content })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Real file export: one .docx per planning document, one .html project dashboard.
// Rendered on demand from what is already in the database — nothing is persisted.
// ---------------------------------------------------------------------------

/** Builds a real .docx file for one planning document (any document, not just the six governance artifacts). */
const DOCX = DOC_COLORS;

/**
 * Splits section text on unanswered gap tokens so each one renders as a visible, highlighted
 * blank instead of leaking `{{gap:3}}` into the Word file.
 */
function runsWithGaps(text: string, bold = false): TextRun[] {
  return splitOnGaps(text).map((part) =>
    part.gap
      ? new TextRun({ text: GAP_LABEL, bold: true, color: DOCX.gapText, highlight: 'yellow' })
      : new TextRun({ text: part.text, bold }),
  );
}

export async function renderDocumentDocx(projectId: string, documentId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, project: true },
  });
  if (!document) throw notFound('Planning document not found');

  const structured = (document.structuredData ?? null) as { raciTable?: RaciRow[]; riskRegister?: RiskRow[] } | null;

  const heading = (text: string) =>
    new Paragraph({
      spacing: { before: 320, after: 140 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: DOCX.rule, space: 6 } },
      children: [new TextRun({ text, bold: true, size: 26, color: DOCX.blue })],
    });

  const { logo } = await customerBranding(document.project.customer);

  const children: (Paragraph | Table)[] = [
    /**
     * The customer's logo above the title block, right-aligned — where a letterhead sits.
     * `docx` takes pixel dimensions, so the image is fitted to a 180×48px box first: dropping it
     * into a fixed box would stretch it, which is worse than showing no logo at all.
     */
    ...(logo
      ? [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { after: 120 },
            children: [
              new ImageRun({
                data: logo.data,
                transformation: fitWithin(logo.data, 180, 48),
                // `docx` names the embedded media part after this, so leaving it undefined
                // produced `…​.undefined` inside the package — a media part with no usable type.
                ...docxImageType(logo.extension),
              } as ConstructorParameters<typeof ImageRun>[0]),
            ],
          }),
        ]
      : []),
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: document.name.toUpperCase(), bold: true, size: 44, color: DOCX.navy })],
    }),
    new Paragraph({
      spacing: { after: 40 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: DOCX.blue, space: 6 } },
      children: [
        new TextRun({ text: document.project.name, bold: true, size: 22, color: DOCX.blue }),
        new TextRun({ text: `   ·   version ${document.version}   ·   ${document.status}`, size: 20, color: DOCX.muted }),
      ],
    }),
    new Paragraph({
      spacing: { before: 120, after: 240 },
      children: [
        new TextRun({
          text: 'AI-drafted from PM-verified project inputs. Highlighted blanks are facts the project data did not contain.',
          italics: true,
          size: 18,
          color: DOCX.muted,
        }),
      ],
    }),
  ];

  for (const section of document.sections.filter((s) => s.included && s.content)) {
    children.push(heading(section.title));
    // Keep the author's paragraph breaks instead of collapsing the section into one block.
    for (const block of (section.content ?? '').split(/\n{2,}/)) {
      children.push(new Paragraph({ spacing: { after: 120 }, children: runsWithGaps(block.trim()) }));
    }
  }

  if (structured?.raciTable?.length) {
    children.push(heading('RACI Matrix'));
    children.push(
      docxTable(
        ['Activity', 'Responsible', 'Accountable', 'Consulted', 'Informed'],
        structured.raciTable.map((row) => [row.activity, row.responsible, row.accountable, row.consulted, row.informed]),
      ),
    );
  }

  if (structured?.riskRegister?.length) {
    children.push(heading('Risk Register'));
    children.push(
      docxTable(
        ['Risk', 'Severity', 'Owner', 'Mitigation'],
        structured.riskRegister.map((row) => [row.risk, row.severity, row.owner, row.mitigation]),
      ),
    );
  }

  // No "PM confirmation needed" list. The open questions are a working aid for the PM and belong
  // in the app, not in a file that gets sent to a customer — a deliverable carrying a list of what
  // its author did not know reads as an unfinished draft no matter how it is labelled. The blanks
  // themselves stay: `runsWithGaps` renders each unanswered `{{gap:N}}` as a highlighted
  // "[ answer needed ]" in place, which is the honest thing and the point of the mechanism.

  /**
   * The customer's mark on every page, not only the first.
   *
   * A planning document gets printed, split and pasted from; page two travelling without any
   * identity is how a page ends up in the wrong pack. Smaller than the title-block logo — a
   * footer mark, not a second letterhead — and aspect-ratio-fitted for the same reason.
   */
  const footers = logo
    ? {
        default: new Footer({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                new ImageRun({
                  data: logo.data,
                  transformation: fitWithin(logo.data, 90, 24),
                  ...docxImageType(logo.extension),
                } as ConstructorParameters<typeof ImageRun>[0]),
              ],
            }),
          ],
        }),
      }
    : undefined;

  const docx = new Document({ sections: [{ footers, children }] });
  const buffer = await Packer.toBuffer(docx);
  const fileName = `${slugForFile(document.name)}-v${document.version}.docx`;
  return { fileName, buffer };
}

function docxTable(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (header) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: DOCX.headerBg },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [
            new Paragraph({ children: [new TextRun({ text: header, bold: true, color: 'FFFFFF', size: 19 })] }),
          ],
        }),
    ),
  });

  const bodyRows = rows.map(
    (row, rowIndex) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              // Zebra striping keeps wide RACI tables readable on paper.
              shading: rowIndex % 2 === 1 ? { type: ShadingType.CLEAR, fill: DOCX.zebra } : undefined,
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [new Paragraph({ children: runsWithGaps(cell, false), spacing: { after: 0 } })],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: DOCX.rule },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: DOCX.rule },
      left: { style: BorderStyle.SINGLE, size: 4, color: DOCX.rule },
      right: { style: BorderStyle.SINGLE, size: 4, color: DOCX.rule },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: DOCX.rule },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: DOCX.rule },
    },
    rows: [headerRow, ...bodyRows],
  });
}

/**
 * Builds a real .xlsx file for one RACI document — the matrix as a sortable, filterable grid,
 * and the prose on a second sheet. Reads exactly the same
 * database rows as `renderDocumentDocx`; only the container differs.
 */
export async function renderDocumentXlsx(
  projectId: string,
  documentId: string,
): Promise<{ fileName: string; buffer: Buffer }> {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, project: true },
  });
  if (!document) throw notFound('Planning document not found');

  const structured = readStructured(document.structuredData);

  return buildDocumentXlsx({
    name: document.name,
    version: document.version,
    status: document.status,
    projectName: document.project.name,
    sections: document.sections.map((section) => ({
      title: section.title,
      content: section.content,
      included: section.included,
    })),
    raciTable: structured?.raciTable ?? [],
    // From the schema, not from the stored data: a register that has not been generated yet still
    // has its own columns, and must never borrow the RACI sheet to stand in for them.
    tableColumns: tableSchema(document.name)?.columns ?? null,
    table: structured?.table ?? null,
  });
}

/**
 * Fills the customer's own file with what the PM has for this document.
 *
 * The sections *are* the fill map: each section's title is the placeholder token and its content
 * is the value, which is why "Edit content" and "Fill out the document" work on a template-backed
 * document without any special handling.
 */
export async function renderDocumentFromTemplate(
  projectId: string,
  documentId: string,
): Promise<{ fileName: string; buffer: Buffer; contentType: string } | null> {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, project: true },
  });
  if (!document) throw notFound('Planning document not found');

  const fill = readStructured(document.structuredData)?.templateFill;
  if (!fill) return null;

  const template = await prisma.customerTemplate.findUnique({ where: { id: fill.templateId } });
  if (!template) {
    throw notFound(
      `The ${fill.customerKey} template this document was generated from is no longer in the customer library. Re-generate the document.`,
    );
  }

  const sourcePath = path.join(env.uploadDir, template.storageKey);
  let source: Buffer;
  try {
    source = await fsp.readFile(sourcePath);
  } catch {
    throw notFound(`"${template.sourceFile}" is recorded in the library but its stored file is missing. Re-upload it.`);
  }

  const values = new Map(document.sections.map((section) => [section.title, section.content ?? '']));

  // The filler follows the template's own file type, not the document's name-based export rule: a
  // workbook template stays a workbook, a deck stays a deck. `template.fileType` is what the parser
  // recorded at upload, so a customer swapping a .pptx for a .docx needs no change here.
  if (template.fileType === 'XLSX') {
    const { buffer } = await fillXlsxTemplate(source, values);
    return {
      fileName: `${slugForFile(document.project.name)}-${slugForFile(document.name)}-v${document.version}.xlsx`,
      buffer,
      contentType: XLSX_CONTENT_TYPE,
    };
  }

  const { buffer } = await fillPptxTemplate(source, values);

  return {
    fileName: `${slugForFile(document.project.name)}-${slugForFile(document.name)}-v${document.version}.pptx`,
    buffer,
    contentType: PPTX_CONTENT_TYPE,
  };
}

const PPTX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * The image kind `docx` expects, from a file extension.
 *
 * It names the embedded media part after this value, so getting it wrong (or leaving it out)
 * writes a part called `…​.undefined` that Word cannot resolve. SVG additionally requires a raster
 * fallback; the same bytes are supplied, which is what `docx` does for a viewer that cannot render
 * the vector — imperfect, but the alternative is refusing the logo.
 */
function docxImageType(extension: string): { type: 'png' | 'jpg' | 'gif' | 'bmp' | 'svg'; fallback?: unknown } {
  switch (extension.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return { type: 'jpg' };
    case '.gif':
      return { type: 'gif' };
    case '.bmp':
      return { type: 'bmp' };
    case '.svg':
      // A raster fallback is mandatory for SVG in OOXML.
      return { type: 'svg', fallback: { type: 'png' as const } };
    default:
      return { type: 'png' };
  }
}

export interface CustomerBranding {
  /** The library's name for the customer when the project's free text resolved to one. */
  customerName: string | null;
  logo: { data: Buffer; extension: string; mimeType: string } | null;
}

/**
 * The customer's name and logo for a project, resolved through the same alias matching everything
 * else uses.
 *
 * One lookup for every generated document, so a new export path cannot quietly ship unbranded:
 * forgetting to call this is visible, whereas duplicating the lookup and omitting the logo is not
 * — which is exactly how the org chart and the Word documents ended up without one.
 *
 * A logo file that has gone missing yields `null` rather than throwing. Losing the branding is a
 * blemish; losing the PM their document over it is not a trade worth making.
 */
export async function customerBranding(customerText: string | null | undefined): Promise<CustomerBranding> {
  // An empty Customer field is not a reason to skip branding: the house-default customer exists
  // to cover it, so a project is never left unbranded just because nobody typed a name.
  const customers = await prisma.customer.findMany({ where: { active: true } });
  const match = matchCustomer(customerText, customers);
  if (!match) return { customerName: customerText ?? null, logo: null };

  const { customer } = match;
  if (!customer.logoStorageKey) return { customerName: customer.name, logo: null };

  try {
    return {
      customerName: customer.name,
      logo: {
        data: await fsp.readFile(path.join(env.uploadDir, customer.logoStorageKey)),
        extension: path.extname(customer.logoFileName ?? '.png'),
        mimeType: customer.logoMimeType ?? 'image/png',
      },
    };
  } catch {
    console.warn(`[branding] ${customer.key} has a logo recorded but its file is missing`);
    return { customerName: customer.name, logo: null };
  }
}

/**
 * Builds a deck for a customer who has no template of their own.
 *
 * Deliberately *not* another customer's template with the name swapped. The SKAX kickoff deck is
 * written about SKAX — a whole slide of R&R prose naming what they supply — so reusing it would
 * assert things about a company nobody checked. This builds a neutral deck from **this** project's
 * own sections, carrying **this** customer's logo.
 */
async function renderNeutralDeck(
  projectId: string,
  documentId: string,
): Promise<{ fileName: string; buffer: Buffer; contentType: string }> {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, project: true },
  });
  if (!document) throw notFound('Planning document not found');

  const branding = await customerBranding(document.project.customer);
  const { logo } = branding;
  const customerName = branding.customerName;

  const slides = document.sections
    .filter((section) => section.included && section.content)
    .map((section) => ({
      title: section.title,
      // One bullet per line or paragraph — the model writes prose, a slide needs points.
      bullets: (section.content ?? '')
        .split(/\n+/)
        .map((line) => line.replace(/^[-•*]\s*/, '').trim())
        .filter(Boolean),
    }));

  const buffer = await buildDeck({
    projectName: document.project.name,
    documentName: document.name,
    customerName,
    subtitle: `Version ${document.version} · ${document.status === DocumentStatus.APPROVED ? 'PM approved · baseline' : 'AI draft · PM review required'}`,
    slides,
    logo,
  });

  return {
    fileName: `${slugForFile(document.project.name)}-${slugForFile(document.name)}-v${document.version}.pptx`,
    buffer,
    contentType: PPTX_CONTENT_TYPE,
  };
}

/**
 * The Organization Chart, drawn: one slide, boxes, one column per organisation.
 *
 * Reuses `buildDeck` for the package scaffolding (content types, master, layout, theme) and then
 * replaces its single slide, so there is one definition of that scaffolding rather than two that
 * could drift apart.
 */
async function renderOrgChartDeck(
  projectId: string,
  documentId: string,
): Promise<{ fileName: string; buffer: Buffer; contentType: string }> {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { project: true },
  });
  if (!document) throw notFound('Planning document not found');

  const chart = readStructured(document.structuredData)?.orgChart ?? { columns: [] };
  const subtitle =
    `${document.project.name} · version ${document.version} · ` +
    (document.status === DocumentStatus.APPROVED ? 'PM approved · baseline' : 'AI draft · PM review required');

  const { customerName, logo } = await customerBranding(document.project.customer);

  // The scaffold is what embeds the logo's media part and slide relationship; `buildOrgChartDeck`
  // only draws it. Both calls have to see the same buffer.
  const scaffold = await buildDeck({
    projectName: document.project.name,
    documentName: document.name,
    customerName,
    subtitle,
    slides: [],
    logo,
  });

  return {
    fileName: `${slugForFile(document.project.name)}-${slugForFile(document.name)}-v${document.version}.pptx`,
    buffer: await buildOrgChartDeck({
      chart,
      title: document.name,
      subtitle,
      scaffold,
      logo: logo?.data ?? null,
    }),
    contentType: PPTX_CONTENT_TYPE,
  };
}

/**
 * The one download entry point: picks the container so a caller never has to know which, and the
 * renderers can never be wired to the wrong document. A document generated from a customer
 * template wins over the name-based rule — it *is* that customer's file.
 */
export async function renderDocumentExport(
  projectId: string,
  documentId: string,
): Promise<{ fileName: string; buffer: Buffer; contentType: string }> {
  const fromTemplate = await renderDocumentFromTemplate(projectId, documentId);
  if (fromTemplate) return fromTemplate;

  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    select: { name: true },
  });
  if (!document) throw notFound('Planning document not found');

  const format = documentExportFormat(document.name);

  // The chart *is* the document — drawn, not described.
  if (isChartDocument(document.name)) return renderOrgChartDeck(projectId, documentId);

  // A deck stays a deck even with no customer template — never silently a Word file.
  if (format === 'PPTX') return renderNeutralDeck(projectId, documentId);

  if (format === 'XLSX') {
    const { fileName, buffer } = await renderDocumentXlsx(projectId, documentId);
    return {
      fileName,
      buffer,
      contentType: XLSX_CONTENT_TYPE,
    };
  }
  const { fileName, buffer } = await renderDocumentDocx(projectId, documentId);
  return {
    fileName,
    buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

/**
 * The project overview dashboard as one self-contained HTML page. Per SKILL.md's rule,
 * it cross-references the other planning documents (risk counts, RACI completeness)
 * rather than standing alone.
 */
export async function renderDashboardHtml(projectId: string): Promise<string> {
  const [project, decision, evaluation, documents] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.approachDecision.findFirst({ where: { projectId, active: true } }),
    prisma.aiApproachSuggestion.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    prisma.planningDocument.findMany({ where: { projectId } }),
  ]);
  if (!project) throw notFound('Project not found');

  const approach = decision?.approach ?? evaluation?.recommendedApproach ?? 'Not yet decided';
  const meta = decision || evaluation ? governanceModelMeta(approach) : null;

  const raciDoc = documents.find((d) => d.name === 'RACI Matrix');
  const riskDoc = documents.find((d) => d.name === 'Risk Plan');
  const raci = (raciDoc?.structuredData as { raciTable?: RaciRow[] } | null)?.raciTable ?? [];
  const risks = (riskDoc?.structuredData as { riskRegister?: RiskRow[] } | null)?.riskRegister ?? [];

  const raciAssigned = raci.filter((row) => row.responsible && !/confirmation required/i.test(row.responsible)).length;
  const raciCompleteness = raci.length ? Math.round((raciAssigned / raci.length) * 100) : null;
  const riskBySeverity = ['Critical', 'High', 'Medium', 'Low'].map((severity) => ({
    severity,
    count: risks.filter((r) => r.severity === severity).length,
  }));

  const approved = documents.filter((d) => d.status === 'APPROVED').length;
  const generated = documents.filter((d) => d.status !== 'NOT_GENERATED').length;

  const rows = documents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => `<tr><td>${escapeHtml(d.name)}</td><td>${d.domain}</td><td>${d.requirement}</td><td>${d.status}</td></tr>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(project.name)} — Project Overview Dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; margin: 0; padding: 32px; background: #f4f7fa; color: #1b2738; }
  h1 { margin: 0 0 4px; }
  .sub { color: #66758a; margin-bottom: 24px; }
  .cards { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
  .card { background: #fff; border: 1px solid #e0e7ee; border-radius: 12px; padding: 18px 20px; min-width: 180px; }
  .card b { display: block; font-size: 1.6rem; margin-top: 6px; }
  .card span { font-size: .72rem; letter-spacing: .08em; color: #76869a; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; border: 1px solid #e0e7ee; }
  th, td { text-align: left; padding: 10px 14px; font-size: .85rem; border-top: 1px solid #edf1f4; }
  th { background: #f6f8fa; font-size: .68rem; letter-spacing: .06em; text-transform: uppercase; color: #78879a; border-top: 0; }
  section { margin-bottom: 28px; }
  .pill { display: inline-block; padding: 3px 9px; border-radius: 99px; font-size: .72rem; background: #eef3f7; color: #33455a; margin-right: 6px; }
</style>
</head>
<body>
  <h1>${escapeHtml(project.name)}</h1>
  <p class="sub">${project.type} · Project Overview Dashboard · generated ${new Date().toISOString().slice(0, 10)}</p>

  <div class="cards">
    <div class="card"><span>Governance model</span><b>${escapeHtml(approach)}</b>${meta ? `<p>${escapeHtml(meta.tagline)}</p>` : ''}</div>
    <div class="card"><span>AI suitability score</span><b>${evaluation?.confidence ?? '—'}%</b></div>
    <div class="card"><span>Documents generated</span><b>${generated}/${documents.length}</b></div>
    <div class="card"><span>Documents approved</span><b>${approved}/${documents.length}</b></div>
    <div class="card"><span>RACI completeness</span><b>${raciCompleteness === null ? '—' : `${raciCompleteness}%`}</b></div>
  </div>

  <section>
    <h2>Risk Plan summary</h2>
    ${risks.length ? riskBySeverity.map((r) => `<span class="pill">${r.severity}: ${r.count}</span>`).join(' ') : '<p>No Risk Plan generated yet.</p>'}
  </section>

  <section>
    <h2>All planning documents</h2>
    <table>
      <thead><tr><th>Document</th><th>Domain</th><th>Requirement</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}
