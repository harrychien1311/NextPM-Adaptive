import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { DocumentStatus, ManagementDomain, Prisma, Requirement } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/http-error';
import { generateDocument, generateGovernanceArtifact, RaciRow, RiskRow } from '../ai/provider';
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
    include: { templates: true },
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
    templates: definition.templates.map((template) => ({
      id: template.id,
      key: template.key,
      name: template.name,
      subtitle: template.subtitle,
      description: template.description,
      recommended: template.recommended,
      fitScore: template.fitScore,
      sections: template.sections,
    })),
    document: byDefinition.get(definition.id)
      ? {
          id: byDefinition.get(definition.id)!.id,
          status: byDefinition.get(definition.id)!.status,
          version: byDefinition.get(definition.id)!.version,
          coverage: byDefinition.get(definition.id)!.coverage,
          templateId: byDefinition.get(definition.id)!.templateId,
          sections: byDefinition.get(definition.id)!.sections,
          pmQuestions: byDefinition.get(definition.id)!.pmQuestions,
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
export async function setGenerationContract(params: {
  projectId: string;
  definitionId: string;
  templateId: string;
  sections?: { title: string; hint?: string; required?: boolean; included?: boolean; custom?: boolean }[];
}) {
  const { projectId, definitionId, templateId } = params;
  const [definition, template] = await Promise.all([
    prisma.documentDefinition.findUnique({ where: { id: definitionId } }),
    prisma.documentTemplate.findUnique({ where: { id: templateId } }),
  ]);
  if (!definition) throw notFound('Document definition not found');
  if (!template || template.definitionId !== definitionId) throw badRequest('Template does not belong to this document');

  const seeded = (template.sections as unknown as { title: string; hint?: string; required?: boolean; defaultIncluded?: boolean }[]).map(
    (section) => ({
      title: section.title,
      hint: section.hint,
      required: section.required ?? false,
      included: section.defaultIncluded ?? true,
      custom: false,
    }),
  );
  const sections = params.sections?.length ? params.sections.map((s) => ({ included: true, required: false, custom: false, ...s })) : seeded;

  const document = await prisma.planningDocument.upsert({
    where: { projectId_definitionId: { projectId, definitionId } },
    create: {
      projectId,
      definitionId,
      templateId,
      name: definition.name,
      domain: definition.domain,
      requirement: definition.requirement,
    },
    update: { templateId, status: DocumentStatus.NOT_GENERATED },
  });

  await prisma.documentSection.deleteMany({ where: { documentId: document.id } });
  await prisma.documentSection.createMany({
    data: sections.map((section, index) => ({
      documentId: document.id,
      title: section.title,
      hint: section.hint ?? null,
      required: Boolean(section.required),
      included: section.included !== false,
      custom: Boolean(section.custom),
      order: index,
    })),
  });

  const included = sections.filter((s) => s.included !== false).length;
  await prisma.planningDocument.update({
    where: { id: document.id },
    data: { coverage: Math.round((included / Math.max(sections.length, 1)) * 100) },
  });

  return prisma.planningDocument.findUnique({
    where: { id: document.id },
    include: { sections: { orderBy: { order: 'asc' } }, template: true },
  });
}

/** Generates the draft for the included sections only. AI drafts; PM approves. */
export async function generateDraft(params: { projectId: string; documentId: string; actorId: string }) {
  const { projectId, documentId, actorId } = params;
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, template: true, project: true, definition: true },
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
  const sections = document.sections.filter((section) => section.included).map((s) => ({ title: s.title, hint: s.hint }));

  let output: { sections: { title: string; content: string }[]; pmQuestions: string[]; unresolved: string[] };
  let structuredData: { raciTable?: RaciRow[]; riskRegister?: RiskRow[] } | null = null;

  if (isGovernanceArtifact(document.name)) {
    const artifactOutput = await generateGovernanceArtifact({
      projectName: document.project.name,
      projectType: document.project.type,
      approach: decision.approach,
      rigor: decision.rigor,
      documentName: document.name,
      templateName: document.template?.name ?? 'Standard',
      verifiedInputs,
      reasons,
      sections,
      artifactName: document.name,
      structureGuidance: artifactGuidance(document.name, decision.approach),
    });
    output = artifactOutput;
    if (artifactOutput.raciTable || artifactOutput.riskRegister) {
      structuredData = { raciTable: artifactOutput.raciTable, riskRegister: artifactOutput.riskRegister };
    }
  } else {
    output = await generateDocument({
      projectName: document.project.name,
      projectType: document.project.type,
      approach: decision.approach,
      rigor: decision.rigor,
      documentName: document.name,
      templateName: document.template?.name ?? 'Standard',
      verifiedInputs,
      reasons,
      sections,
    });
  }

  const contentByTitle = new Map(output.sections.map((section) => [section.title, section.content]));

  await prisma.$transaction([
    ...document.sections.map((section) =>
      prisma.documentSection.update({
        where: { id: section.id },
        data: { content: section.included ? contentByTitle.get(section.title) ?? null : null },
      }),
    ),
    prisma.planningDocument.update({
      where: { id: documentId },
      data: {
        status: DocumentStatus.PM_REVIEW,
        generatedAt: new Date(),
        pmQuestions: output.pmQuestions as unknown as Prisma.InputJsonValue,
        structuredData: structuredData ? (structuredData as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        sourceTrace: {
          verifiedInputs: verified.length,
          reasons,
          confidence: evaluation?.confidence ?? null,
          template: document.template?.name ?? 'Standard',
          approach: decision.approach,
          unresolved: output.unresolved,
        } as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);

  await logEvent({
    projectId,
    actorId,
    actorType: 'AGENT',
    type: 'DOCUMENT_GENERATED',
    title: `${document.name} generated`,
    detail: `${verified.length} verified inputs + ${decision.approach} governance model`,
    payload: { documentId, unresolved: output.unresolved },
  });

  return prisma.planningDocument.findUnique({
    where: { id: documentId },
    include: { sections: { orderBy: { order: 'asc' } }, template: true },
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
export async function renderDocumentDocx(projectId: string, documentId: string): Promise<{ fileName: string; buffer: Buffer }> {
  const document = await prisma.planningDocument.findFirst({
    where: { id: documentId, projectId },
    include: { sections: { orderBy: { order: 'asc' } }, project: true },
  });
  if (!document) throw notFound('Planning document not found');

  const structured = (document.structuredData ?? null) as { raciTable?: RaciRow[]; riskRegister?: RiskRow[] } | null;
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: document.name, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({ text: `${document.project.name} · version ${document.version} · status ${document.status}`, italics: true }),
      ],
    }),
  ];

  for (const section of document.sections.filter((s) => s.included && s.content)) {
    children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: section.content ?? '' }));
  }

  if (document.name === 'Organization Chart') {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: 'Rendered as a structured text/table representation of the reporting hierarchy — not a graphical diagram.',
            italics: true,
          }),
        ],
      }),
    );
  }

  if (structured?.raciTable?.length) {
    children.push(new Paragraph({ text: 'RACI Table', heading: HeadingLevel.HEADING_2 }));
    children.push(
      docxTable(
        ['Activity', 'Responsible', 'Accountable', 'Consulted', 'Informed'],
        structured.raciTable.map((row) => [row.activity, row.responsible, row.accountable, row.consulted, row.informed]),
      ),
    );
  }

  if (structured?.riskRegister?.length) {
    children.push(new Paragraph({ text: 'Risk Register', heading: HeadingLevel.HEADING_2 }));
    children.push(
      docxTable(
        ['Risk', 'Severity', 'Owner', 'Mitigation'],
        structured.riskRegister.map((row) => [row.risk, row.severity, row.owner, row.mitigation]),
      ),
    );
  }

  if (document.pmQuestions && (document.pmQuestions as unknown as string[]).length) {
    children.push(new Paragraph({ text: 'Open PM Questions', heading: HeadingLevel.HEADING_2 }));
    for (const question of document.pmQuestions as unknown as string[]) {
      children.push(new Paragraph({ text: `• ${question}` }));
    }
  }

  const docx = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(docx);
  const fileName = `${slugForFile(document.name)}-v${document.version}.docx`;
  return { fileName, buffer };
}

function docxTable(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    children: headers.map(
      (h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] }),
    ),
  });
  const bodyRows = rows.map(
    (row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })) }),
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] });
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
