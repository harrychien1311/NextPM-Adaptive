import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { ManagementDomain, PrismaClient, ProjectStatus, ProjectType, Requirement, Role } from '@prisma/client';
import { INPUT_SCHEMAS } from '../src/data/input-schemas';
import { BASE_TEMPLATES, DELIVERY_TEMPLATE, DOCUMENT_CATALOG } from '../src/data/document-catalog';

const prisma = new PrismaClient();

async function seedUsers() {
  const password = await bcrypt.hash('NextPM!2026', 10);
  const people = [
    { email: 'lina.vuong@nextpm.local', name: 'Lina Vuong', initials: 'LV', role: Role.PORTFOLIO_MANAGER, jobTitle: 'Project Manager' },
    { email: 'nam.hoang@nextpm.local', name: 'Nam Hoang', initials: 'NH', role: Role.PROJECT_MANAGER, jobTitle: 'Delivery Manager' },
    { email: 'an.nguyen@nextpm.local', name: 'An Nguyen', initials: 'AN', role: Role.MEMBER, jobTitle: 'Business Analyst' },
    { email: 'bao.tran@nextpm.local', name: 'Bao Tran', initials: 'BT', role: Role.MEMBER, jobTitle: 'Service Lead' },
    { email: 'ha.pham@nextpm.local', name: 'Ha Pham', initials: 'HA', role: Role.MEMBER, jobTitle: 'Product Owner' },
    { email: 'admin@nextpm.local', name: 'Platform Admin', initials: 'PA', role: Role.ADMIN, jobTitle: 'Administrator' },
  ];

  const users: Record<string, string> = {};
  for (const person of people) {
    const user = await prisma.user.upsert({
      where: { email: person.email },
      create: { ...person, passwordHash: password },
      update: { name: person.name, role: person.role },
    });
    users[person.initials] = user.id;
  }
  return users;
}

async function seedInputSchemas() {
  for (const [type, fields] of Object.entries(INPUT_SCHEMAS) as [ProjectType, typeof INPUT_SCHEMAS.SI][]) {
    for (const [index, field] of fields.entries()) {
      await prisma.inputFieldDefinition.upsert({
        where: { projectType_key: { projectType: type, key: field.key } },
        create: {
          projectType: type,
          key: field.key,
          label: field.label,
          fieldType: field.fieldType,
          options: field.options ?? [],
          required: field.required ?? true,
          domain: field.domain,
          signalKey: field.signalKey ?? field.key,
          order: index,
        },
        update: {
          label: field.label,
          options: field.options ?? [],
          domain: field.domain,
          order: index,
          signalKey: field.signalKey ?? field.key,
        },
      });
    }
  }
}

async function seedDocumentCatalog() {
  for (const [type, domains] of Object.entries(DOCUMENT_CATALOG) as [ProjectType, Record<ManagementDomain, { name: string; requirement: Requirement; conditionKey?: string }[]>][]) {
    for (const [domain, entries] of Object.entries(domains) as [ManagementDomain, { name: string; requirement: Requirement; conditionKey?: string }[]][]) {
      for (const [index, entry] of entries.entries()) {
        const definition = await prisma.documentDefinition.upsert({
          where: { projectType_domain_name: { projectType: type, domain, name: entry.name } },
          create: {
            projectType: type,
            domain,
            name: entry.name,
            requirement: entry.requirement,
            conditionKey: entry.conditionKey,
            order: index,
          },
          update: { requirement: entry.requirement, conditionKey: entry.conditionKey, order: index },
        });

        const delivery = DELIVERY_TEMPLATE[type];
        const templates = [
          { key: 'standard', ...BASE_TEMPLATES.standard },
          { key: 'lean', ...BASE_TEMPLATES.lean },
          {
            key: 'delivery',
            name: delivery.name,
            subtitle: delivery.subtitle,
            description: delivery.description,
            recommended: false,
            fitScore: 88,
            sections: delivery.sections,
          },
        ];

        for (const template of templates) {
          await prisma.documentTemplate.upsert({
            where: { definitionId_key: { definitionId: definition.id, key: template.key } },
            create: {
              definitionId: definition.id,
              key: template.key,
              name: template.name,
              subtitle: template.subtitle,
              description: template.description,
              recommended: template.recommended,
              fitScore: template.fitScore,
              sections: template.sections as unknown as object,
            },
            update: { sections: template.sections as unknown as object, fitScore: template.fitScore },
          });
        }
      }
    }
  }
}

interface ProjectSeed {
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  summary: string;
  targetLabel: string;
  programKey: string | null;
  members: string[];
  fillInputs: boolean;
  verifyInputs?: boolean;
  approach?: string;
  generateSome?: boolean;
}

const PROJECTS: ProjectSeed[] = [
  { name: 'KR Commerce Modernization', type: ProjectType.SI, status: ProjectStatus.ACTIVE, summary: 'System Integration · Korea–Vietnam delivery', targetLabel: 'Mar 31 target', programKey: 'digital-commerce-program', members: ['LV', 'NH'], fillInputs: true, verifyInputs: true, approach: 'HYBRID', generateSome: true },
  { name: 'Customer Loyalty Platform', type: ProjectType.PRODUCT, status: ProjectStatus.ACTIVE, summary: 'Product Development · Omnichannel loyalty', targetLabel: 'Q1 pilot', programKey: 'digital-commerce-program', members: ['LV', 'AN'], fillInputs: true, verifyInputs: true, approach: 'SCRUM', generateSome: true },
  { name: 'Smart Factory Phase 2', type: ProjectType.SI, status: ProjectStatus.DRAFT, summary: 'System Integration · Initial assessment', targetLabel: '— target', programKey: 'manufacturing-transformation', members: ['LV'], fillInputs: false },
  { name: 'MES Rollout Wave 1', type: ProjectType.SI, status: ProjectStatus.CLOSED, summary: 'System Integration · Baseline archived', targetLabel: 'Jun 30 closed', programKey: 'manufacturing-transformation', members: ['LV', 'NH'], fillInputs: true, verifyInputs: true, approach: 'HYBRID', generateSome: true },
  { name: 'SK Manufacturing AMS', type: ProjectType.SM, status: ProjectStatus.ACTIVE, summary: 'Service Management · Application maintenance', targetLabel: 'Dec 31 renewal', programKey: 'managed-services-program', members: ['LV', 'BT'], fillInputs: true, verifyInputs: true, approach: 'HYBRID', generateSome: true },
  { name: 'Legacy ERP Support', type: ProjectType.SM, status: ProjectStatus.HOLD, summary: 'Service Management · Pending renewal', targetLabel: 'Oct 15 review', programKey: 'managed-services-program', members: ['LV', 'HA'], fillInputs: true, verifyInputs: true, approach: 'HYBRID' },
  { name: 'AI Quality Assistant', type: ProjectType.PRODUCT, status: ProjectStatus.ACTIVE, summary: 'Product Development · Internal innovation', targetLabel: 'Q4 pilot', programKey: 'innovation-products', members: ['LV', 'HA'], fillInputs: true, verifyInputs: true, approach: 'SCRUM' },
  { name: 'Security Gateway Upgrade', type: ProjectType.SI, status: ProjectStatus.ACTIVE, summary: 'System Integration · Infrastructure modernization', targetLabel: 'Nov 15 target', programKey: null, members: ['LV'], fillInputs: true, verifyInputs: true, approach: 'WATERFALL' },
];

const PROGRAMS = [
  { key: 'digital-commerce-program', name: 'Digital Commerce Program', description: 'Modernize customer-facing commerce across Korea channels', colorKey: 'blue' },
  { key: 'manufacturing-transformation', name: 'Manufacturing Transformation', description: 'Factory digitization, MES and shop-floor integration', colorKey: 'violet' },
  { key: 'managed-services-program', name: 'Managed Services Program', description: 'Application support, service transition and SLA governance', colorKey: 'green' },
  { key: 'innovation-products', name: 'Innovation Products', description: 'Internal AI products moving from experiment to scale', colorKey: 'orange' },
];

async function main() {
  console.log('▸ seeding users');
  const users = await seedUsers();

  console.log('▸ seeding input schemas and document catalog');
  await seedInputSchemas();
  await seedDocumentCatalog();

  console.log('▸ seeding portfolio hierarchy');
  const portfolio = await prisma.portfolio.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'FKR Delivery Portfolio',
      businessUnit: 'FPT Software Korea',
      strategicObjective: 'Prioritize and govern related investments',
      ownerId: users.LV,
    },
    update: {},
  });

  const programIds: Record<string, string> = {};
  for (const program of PROGRAMS) {
    const record = await prisma.program.upsert({
      where: { portfolioId_key: { portfolioId: portfolio.id, key: program.key } },
      create: { ...program, portfolioId: portfolio.id, ownerId: users.LV },
      update: { name: program.name, description: program.description },
    });
    programIds[program.key] = record.id;
  }

  console.log('▸ seeding project workspaces');
  for (const seed of PROJECTS) {
    const existing = await prisma.project.findFirst({ where: { name: seed.name, portfolioId: portfolio.id } });
    if (existing) {
      console.log(`  · ${seed.name} already present, skipping`);
      continue;
    }

    const definitions = await prisma.inputFieldDefinition.findMany({
      where: { projectType: seed.type },
      orderBy: { order: 'asc' },
    });
    const schema = INPUT_SCHEMAS[seed.type];

    const project = await prisma.project.create({
      data: {
        portfolioId: portfolio.id,
        programId: seed.programKey ? programIds[seed.programKey] : null,
        name: seed.name,
        type: seed.type,
        status: seed.status,
        summary: seed.summary,
        targetLabel: seed.targetLabel,
        phaseLabel: `${seed.type} · ${seed.status === ProjectStatus.DRAFT ? 'INITIATING' : 'PLANNING'}`,
        customer: 'Korea — Enterprise',
        members: {
          create: seed.members.map((initials, index) => ({
            userId: users[initials],
            role: index === 0 ? Role.PROJECT_MANAGER : Role.MEMBER,
          })),
        },
        inputValues: {
          create: definitions.map((definition) => {
            const field = schema.find((item) => item.key === definition.key);
            const value = seed.fillInputs ? field?.defaultValue ?? null : null;
            return {
              definitionId: definition.id,
              value,
              verified: Boolean(value && seed.verifyInputs),
              verifiedById: value && seed.verifyInputs ? users.LV : null,
              verifiedAt: value && seed.verifyInputs ? new Date() : null,
            };
          }),
        },
        customFields: seed.fillInputs
          ? { create: [{ name: 'Peak traffic event', value: '11.11 campaign — zero downtime', useIn: 'BOTH' }] }
          : undefined,
        tasks: {
          create: [
            { title: 'Project profile confirmed', detail: `${definitions.filter((d) => d.required).length} required inputs`, state: seed.verifyInputs ? 'DONE' : 'TODO', order: 0 },
            { title: `${seed.approach ?? 'Management'} approach approved`, detail: 'Decision by Lina Vuong', state: seed.approach ? 'DONE' : 'TODO', order: 1 },
            { title: 'Scope & Requirements Plan', detail: '3 PM questions', state: seed.generateSome ? 'REVIEW' : 'TODO', order: 2 },
            { title: 'Risk & Dependency Plan', detail: 'Dependency owner missing', state: seed.generateSome ? 'BLOCKED' : 'TODO', order: 3 },
          ],
        },
        dashboardLayouts: {
          create: {
            userId: users.LV,
            widgets: { readiness: true, approach: true, outputs: true, tasks: true, decisions: true, domains: true, activity: true },
          },
        },
      },
    });

    // Domain readiness snapshot
    const domains: ManagementDomain[] = ['GOVERNANCE', 'SCOPE', 'SCHEDULE', 'FINANCE', 'STAKEHOLDERS', 'RESOURCES', 'RISK'];
    const sample = seed.fillInputs ? [88, 76, 69, 74, 82, 71, 48] : [12, 8, 0, 0, 20, 0, 0];
    await prisma.domainReadiness.createMany({
      data: domains.map((domain, index) => ({ projectId: project.id, domain, score: sample[index] ?? 0 })),
    });

    if (seed.approach) {
      const { runEvaluation, decideApproach } = await import('../src/modules/rules/rules.service');
      const evaluation = await runEvaluation(project.id, users.LV);
      await decideApproach({
        projectId: project.id,
        approach: seed.approach,
        outcome: seed.approach === evaluation.recommendedApproach ? 'CONFIRMED' : 'OVERRIDDEN',
        rationale:
          seed.approach === evaluation.recommendedApproach
            ? 'AI recommendation matches the commercial and delivery constraints agreed with the customer.'
            : 'PM override: customer governance requires this model regardless of the AI recommendation.',
        decidedById: users.LV,
      });
      await prisma.project.update({ where: { id: project.id }, data: { status: seed.status } });
    }

    if (seed.generateSome) {
      const { setGenerationContract, generateDraft, approveDocument } = await import('../src/modules/documents/documents.service');
      const definitionsToDraft = await prisma.documentDefinition.findMany({
        where: { projectType: seed.type, domain: 'GOVERNANCE' },
        include: { templates: true },
        orderBy: { order: 'asc' },
        take: 2,
      });
      for (const [index, definition] of definitionsToDraft.entries()) {
        const template = definition.templates.find((item) => item.recommended) ?? definition.templates[0];
        const document = await setGenerationContract({
          projectId: project.id,
          definitionId: definition.id,
          templateId: template.id,
        });
        try {
          await generateDraft({ projectId: project.id, documentId: document!.id, actorId: users.LV });
          if (index === 0) await approveDocument({ projectId: project.id, documentId: document!.id, actorId: users.LV });
        } catch (error) {
          console.log(`    · skipped draft for ${definition.name}: ${(error as Error).message}`);
        }
      }
    }

    await prisma.agentMessage.create({
      data: {
        projectId: project.id,
        role: 'AGENT',
        content: `I recommend a ${seed.approach ?? 'Hybrid'} governance model based on the AI recommendation. Baseline the fixed commitments, plan detail in two-sprint horizons and use a formal change threshold.`,
        meta: { decisionApplied: false },
      },
    });

    console.log(`  · ${seed.name} (${seed.type})`);
  }

  console.log('\n✓ seed complete');
  console.log('  login: lina.vuong@nextpm.local / NextPM!2026');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
