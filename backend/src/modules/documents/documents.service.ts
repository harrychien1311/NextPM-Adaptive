import {
  BorderStyle,
  Document,
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
  generateDocument,
  generateGovernanceArtifact,
  type DocumentGap,
  type GenerationOutput,
  type RaciRow,
  type RiskRow,
} from '../ai/provider';
import { logEvent } from '../audit/audit.service';
import { DELIVERY_TEMPLATE } from '../../data/document-catalog';
import { artifactGuidance, governanceModelMeta, isGovernanceArtifact } from '../../data/governance-models';

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

  return definitions.map((definition) => ({
    definitionId: definition.id,
    name: definition.name,
    domain: definition.domain,
    requirement: definition.requirement,
    conditionKey: definition.conditionKey,
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
  let structuredData: { raciTable?: RaciRow[]; riskRegister?: RiskRow[] } | null = null;

  if (isGovernanceArtifact(document.name)) {
    const artifactOutput = await generateGovernanceArtifact({
      ...generationContext,
      artifactName: document.name,
      structureGuidance: artifactGuidance(document.name, decision.approach),
    });
    output = artifactOutput;
    if (artifactOutput.raciTable || artifactOutput.riskRegister) {
      structuredData = { raciTable: artifactOutput.raciTable, riskRegister: artifactOutput.riskRegister };
    }
  } else {
    output = await generateDocument(generationContext);
  }

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

/** Normalises the JSON column, which held plain strings before gaps existed. */
export function readGaps(value: unknown): DocumentGap[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry, index): DocumentGap | null => {
      if (typeof entry === 'string') return { token: `{{gap:${index + 1}}}`, question: entry, answer: null };
      if (entry && typeof entry === 'object' && 'question' in entry) {
        const gap = entry as DocumentGap;
        return { token: gap.token, question: gap.question, answer: gap.answer ?? null };
      }
      return null;
    })
    .filter((gap): gap is DocumentGap => gap !== null);
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

  const structured = (document.structuredData ?? null) as { raciTable?: RaciRow[]; riskRegister?: RiskRow[] } | null;
  const nextStructured = structured
    ? {
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

  return updated;
}

export async function documentDetail(projectId: string, documentId: string) {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: {
      sections: { orderBy: { order: 'asc' } },
      template: true,
      approvedBy: { select: { id: true, name: true, initials: true } },
    },
  });
  if (!document) throw notFound('Planning document not found');
  return document;
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
/** Brand palette for the Word export — same navy/blue as the app's design system. */
const DOCX = {
  navy: '10243D',
  blue: '1F5FA9',
  rule: 'C9D6E6',
  headerBg: '10243D',
  zebra: 'F4F7FB',
  gapText: 'B26A00',
  gapBg: 'FFF1D6',
  muted: '6B7C93',
} as const;

const GAP_PATTERN = /\{\{gap:\d+\}\}/g;

/**
 * Splits section text on unanswered gap tokens so each one renders as a visible, highlighted
 * blank instead of leaking `{{gap:3}}` into the Word file.
 */
function runsWithGaps(text: string, bold = false): TextRun[] {
  const runs: TextRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(GAP_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) runs.push(new TextRun({ text: text.slice(cursor, index), bold }));
    runs.push(
      new TextRun({ text: '[ answer needed ]', bold: true, color: DOCX.gapText, highlight: 'yellow' }),
    );
    cursor = index + match[0].length;
  }
  if (cursor < text.length) runs.push(new TextRun({ text: text.slice(cursor), bold }));
  return runs.length ? runs : [new TextRun({ text, bold })];
}

export async function renderDocumentDocx(projectId: string, documentId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, project: true },
  });
  if (!document) throw notFound('Planning document not found');

  const structured = (document.structuredData ?? null) as { raciTable?: RaciRow[]; riskRegister?: RiskRow[] } | null;
  const gaps = readGaps(document.pmQuestions);

  const heading = (text: string) =>
    new Paragraph({
      spacing: { before: 320, after: 140 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: DOCX.rule, space: 6 } },
      children: [new TextRun({ text, bold: true, size: 26, color: DOCX.blue })],
    });

  const children: (Paragraph | Table)[] = [
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

  if (document.name === 'Organization Chart') {
    children.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [
          new TextRun({
            text: 'Rendered as a structured text/table representation of the reporting hierarchy — not a graphical diagram.',
            italics: true,
            size: 18,
            color: DOCX.muted,
          }),
        ],
      }),
    );
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

  if (gaps.length) {
    children.push(heading('PM confirmation needed'));
    children.push(
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: 'These facts were not present in the project data, so they were left blank rather than guessed:',
            italics: true,
            size: 18,
            color: DOCX.muted,
          }),
        ],
      }),
    );
    for (const gap of gaps) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 60 },
          children: [new TextRun({ text: gap.question, color: DOCX.gapText })],
        }),
      );
    }
  }

  const docx = new Document({ sections: [{ children }] });
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

function slugForFile(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
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
