import { DocumentStatus, ProjectStatus, ProjectType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/http-error';
import { slugify } from '../../lib/slug';
import { INPUT_SCHEMAS } from '../../data/input-schemas';
import { computeInputReadiness } from '../../lib/readiness';
import { logEvent } from '../audit/audit.service';

const COLOR_ROTATION = ['blue', 'violet', 'green', 'orange'];

export async function listPortfolios() {
  return prisma.portfolio.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      owner: { select: { id: true, name: true, initials: true } },
      _count: { select: { programs: true, projects: true } },
    },
  });
}

export async function createPortfolio(params: {
  name: string;
  businessUnit?: string;
  strategicObjective?: string;
  ownerId: string;
}) {
  return prisma.portfolio.create({
    data: {
      name: params.name,
      businessUnit: params.businessUnit,
      strategicObjective: params.strategicObjective,
      ownerId: params.ownerId,
    },
  });
}

export async function createProgram(params: {
  portfolioId: string;
  name: string;
  description?: string;
  targetOutcome?: string;
  ownerId?: string;
}) {
  const count = await prisma.program.count({ where: { portfolioId: params.portfolioId } });
  return prisma.program.create({
    data: {
      portfolioId: params.portfolioId,
      key: slugify(params.name),
      name: params.name,
      description: params.description,
      targetOutcome: params.targetOutcome,
      colorKey: COLOR_ROTATION[count % COLOR_ROTATION.length],
      ownerId: params.ownerId,
    },
  });
}

/** Readiness for one project: input readiness blended with approved-output share. */
async function projectReadiness(projectId: string) {
  const [values, documents] = await Promise.all([
    prisma.projectInputValue.findMany({ where: { projectId }, include: { definition: true } }),
    prisma.planningDocument.findMany({ where: { projectId } }),
  ]);

  const input = computeInputReadiness(
    values.map((value) => ({ value: value.value, verified: value.verified, required: value.definition.required })),
  );

  const generated = documents.filter((doc) => doc.status !== DocumentStatus.NOT_GENERATED).length;
  const approved = documents.filter((doc) => doc.status === DocumentStatus.APPROVED).length;
  const outputShare = documents.length ? Math.round((approved / documents.length) * 100) : 0;

  const readiness = documents.length
    ? Math.round(input.readiness * 0.5 + outputShare * 0.5)
    : input.readiness;

  return {
    readiness,
    inputReadiness: input.readiness,
    verifiedInputs: input.verified,
    totalInputs: input.total,
    documentsTotal: documents.length,
    documentsGenerated: generated,
    documentsApproved: approved,
    documentsInReview: documents.filter((doc) => doc.status === DocumentStatus.PM_REVIEW).length,
  };
}

/** The portfolio overview screen: programs, their projects, and roll-up health. */
export async function portfolioOverview(portfolioId: string) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    include: {
      programs: { orderBy: { createdAt: 'asc' } },
      projects: {
        orderBy: { createdAt: 'asc' },
        include: {
          program: true,
          members: { include: { user: { select: { id: true, initials: true, name: true } } } },
          _count: { select: { actionItems: true } },
        },
      },
    },
  });
  if (!portfolio) throw notFound('Portfolio not found');

  const enriched = await Promise.all(
    portfolio.projects.map(async (project) => {
      const stats = await projectReadiness(project.id);
      const [decision, openActions] = await Promise.all([
        prisma.approachDecision.findFirst({ where: { projectId: project.id, active: true } }),
        prisma.actionItem.count({ where: { projectId: project.id, status: 'OPEN' } }),
      ]);
      return {
        id: project.id,
        name: project.name,
        type: project.type,
        status: project.status,
        summary: project.summary,
        targetLabel: project.targetLabel,
        programKey: project.program?.key ?? 'standalone',
        programName: project.program?.name ?? 'Standalone',
        approach: decision?.approach ?? null,
        openDecisions: openActions,
        members: project.members.map((member) => member.user),
        ...stats,
      };
    }),
  );

  const groups = [
    ...portfolio.programs.map((program) => {
      const projects = enriched.filter((project) => project.programKey === program.key);
      const active = projects.filter((project) => project.status === ProjectStatus.ACTIVE);
      const rollup = active.length
        ? Math.round(active.reduce((sum, project) => sum + project.readiness, 0) / active.length)
        : null;
      return {
        key: program.key,
        id: program.id,
        name: program.name,
        description: program.description,
        colorKey: program.colorKey,
        readiness: rollup,
        health: rollup === null ? 'none' : rollup >= 75 ? 'good' : rollup >= 60 ? 'watch' : 'risk',
        projects,
      };
    }),
    {
      key: 'standalone',
      id: null,
      name: 'Standalone projects',
      description: 'Projects managed directly at portfolio level',
      colorKey: 'none',
      readiness: null,
      health: 'none',
      projects: enriched.filter((project) => project.programKey === 'standalone'),
    },
  ];

  const active = enriched.filter((project) => project.status === ProjectStatus.ACTIVE);
  const summary = {
    programs: portfolio.programs.length,
    activePrograms: groups.filter((group) => group.health === 'good').length,
    activeProjects: active.length,
    byType: {
      SI: active.filter((project) => project.type === ProjectType.SI).length,
      SM: active.filter((project) => project.type === ProjectType.SM).length,
      PRODUCT: active.filter((project) => project.type === ProjectType.PRODUCT).length,
    },
    needsAttention: enriched.filter((project) => project.openDecisions > 0).length,
    pendingDecisions: enriched.reduce((sum, project) => sum + project.openDecisions, 0),
    portfolioReadiness: active.length
      ? Math.round(active.reduce((sum, project) => sum + project.readiness, 0) / active.length)
      : 0,
    statusCounts: {
      all: enriched.length,
      active: active.length,
      draft: enriched.filter((project) => project.status === ProjectStatus.DRAFT).length,
      hold: enriched.filter((project) => project.status === ProjectStatus.HOLD).length,
      closed: enriched.filter((project) => project.status === ProjectStatus.CLOSED).length,
    },
  };

  return { portfolio: { id: portfolio.id, name: portfolio.name }, summary, groups };
}

/**
 * Creating a project provisions the type-specific input profile, the default
 * dashboard layout and the initial planning tasks — nothing is generated yet.
 */
export async function createProject(params: {
  portfolioId: string;
  programId?: string | null;
  name: string;
  type: ProjectType;
  customer?: string;
  targetStart?: string;
  targetEnd?: string;
  ownerId: string;
}) {
  const definitions = await prisma.inputFieldDefinition.findMany({ where: { projectType: params.type } });

  const project = await prisma.project.create({
    data: {
      portfolioId: params.portfolioId,
      programId: params.programId || null,
      name: params.name,
      type: params.type,
      status: ProjectStatus.DRAFT,
      customer: params.customer,
      summary: `${params.type} workspace · Planning setup not started`,
      phaseLabel: `${params.type} · INITIATING`,
      targetStart: params.targetStart ? new Date(params.targetStart) : null,
      targetEnd: params.targetEnd ? new Date(params.targetEnd) : null,
      members: { create: { userId: params.ownerId, role: 'PROJECT_MANAGER' } },
      inputValues: {
        create: definitions.map((definition) => ({ definitionId: definition.id, value: null, verified: false })),
      },
      tasks: {
        create: [
          { title: 'Complete minimum project profile', detail: `${definitions.filter((d) => d.required).length} required inputs`, state: 'TODO', order: 0 },
          { title: 'Verify inputs & get AI recommendation', detail: 'Governance-model recommendation', state: 'TODO', order: 1 },
          { title: 'Confirm governance model', detail: 'PM decision gate', state: 'TODO', order: 2 },
          { title: 'Generate & approve planning pack', detail: 'AI drafts, PM approves', state: 'TODO', order: 3 },
        ],
      },
      domainReadiness: {
        create: (['GOVERNANCE', 'SCOPE', 'SCHEDULE', 'FINANCE', 'STAKEHOLDERS', 'RESOURCES', 'RISK'] as const).map((domain) => ({
          domain,
          score: 0,
        })),
      },
      dashboardLayouts: {
        create: {
          userId: params.ownerId,
          widgets: {
            readiness: true,
            approach: true,
            outputs: true,
            tasks: true,
            decisions: true,
            domains: true,
            activity: true,
          } as Prisma.InputJsonValue,
        },
      },
    },
  });

  await logEvent({
    projectId: project.id,
    actorId: params.ownerId,
    type: 'PROJECT_CREATED',
    title: `${params.type} workspace created`,
    detail: `${INPUT_SCHEMAS[params.type].length} input fields provisioned from the ${params.type} schema`,
  });

  return project;
}

export async function projectWorkspace(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      program: true,
      portfolio: { select: { id: true, name: true } },
      members: { include: { user: { select: { id: true, name: true, initials: true } } } },
    },
  });
  if (!project) throw notFound('Project not found');

  const [stats, decision, evaluation] = await Promise.all([
    projectReadiness(projectId),
    prisma.approachDecision.findFirst({ where: { projectId, active: true } }),
    prisma.aiApproachSuggestion.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
  ]);

  return {
    id: project.id,
    name: project.name,
    type: project.type,
    status: project.status,
    phaseLabel: project.phaseLabel ?? `${project.type} · INITIATING`,
    portfolio: project.portfolio,
    program: project.program ? { id: project.program.id, name: project.program.name, key: project.program.key } : null,
    members: project.members.map((member) => member.user),
    approach: decision
      ? { approach: decision.approach, rigor: decision.rigor, outcome: decision.outcome, decidedAt: decision.decidedAt }
      : null,
    recommendation: evaluation
      ? { approach: evaluation.recommendedApproach, confidence: evaluation.confidence }
      : null,
    ...stats,
  };
}

export async function updateProject(projectId: string, data: Prisma.ProjectUpdateInput) {
  return prisma.project.update({ where: { id: projectId }, data });
}
