import {
  DocumentStatus,
  InputSource as ProjectInputSource,
  ProjectRole,
  ProjectStatus,
  ProjectType,
  Prisma,
  Role,
} from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { conflict, forbidden, notFound } from '../../lib/http-error';
import { slugify } from '../../lib/slug';
import { INPUT_SCHEMAS } from '../../data/input-schemas';
import { computeInputReadiness } from '../../lib/readiness';
import { checklistScoreForProject } from '../checklist/checklist.service';
import { logEvent } from '../audit/audit.service';

const COLOR_ROTATION = ['blue', 'violet', 'green', 'orange'];

/** Programs are the top of the hierarchy — only a PROGRAM_OWNER may create one. */
export async function createProgram(params: {
  name: string;
  description?: string;
  targetOutcome?: string;
  ownerId: string;
}) {
  const key = slugify(params.name);
  const existing = await prisma.program.findUnique({ where: { key } });
  if (existing) throw conflict('A program with a similar name already exists');

  const count = await prisma.program.count();
  return prisma.program.create({
    data: {
      key,
      name: params.name,
      description: params.description,
      targetOutcome: params.targetOutcome,
      colorKey: COLOR_ROTATION[count % COLOR_ROTATION.length],
      ownerId: params.ownerId,
    },
  });
}

export async function updateProgram(
  programId: string,
  data: { name?: string; description?: string | null; targetOutcome?: string | null },
) {
  const program = await prisma.program.findUnique({ where: { id: programId } });
  if (!program) throw notFound('Program not found');

  // The key is the slug the UI filters by, so it follows the name — but it must stay unique.
  let key = program.key;
  if (data.name && data.name !== program.name) {
    key = slugify(data.name);
    const clash = await prisma.program.findFirst({ where: { key, NOT: { id: programId } } });
    if (clash) throw conflict('A program with a similar name already exists');
  }

  return prisma.program.update({ where: { id: programId }, data: { ...data, key } });
}

/**
 * Deletes a program. Its projects are NOT deleted: `Project.programId` is `onDelete: SetNull`, so
 * they survive as standalone projects. The caller is told how many were released so the UI can
 * say so before the user confirms.
 */
export async function deleteProgram(programId: string) {
  const program = await prisma.program.findUnique({
    where: { id: programId },
    include: { _count: { select: { projects: true } } },
  });
  if (!program) throw notFound('Program not found');

  await prisma.program.delete({ where: { id: programId } });
  return { deleted: true, name: program.name, projectsReleased: program._count.projects };
}

/**
 * Deletes a project and everything hanging off it — inputs, uploaded references, recommendations,
 * decisions, generated documents, tasks and the audit trail all cascade. There is no undo, which
 * is why the route restricts this to the project's own owner or the program owner.
 */
export async function deleteProject(projectId: string, user: { id: string; role: Role }) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, ownerId: true, _count: { select: { documents: true } } },
  });
  if (!project) throw notFound('Project not found');

  if (user.role !== Role.PROGRAM_OWNER && project.ownerId !== user.id) {
    throw forbidden('Only the project owner or the program owner can delete a project');
  }

  await prisma.project.delete({ where: { id: projectId } });
  return { deleted: true, name: project.name, documentsRemoved: project._count.documents };
}

/**
 * Readiness for one project — the number the Ready-to-Start ring shows.
 *
 * **Once the customer's own standard has been assessed, that standard and the approved planning
 * outputs are the whole score.** Input readiness drops out of it deliberately: how much of *our*
 * intake form is filled in is our administration, not a measure of whether this project can start.
 * What can be defended in front of the customer is how far the project meets the criteria that
 * customer standardised, and how much of the plan the PM has actually approved.
 *
 * The customer standard carries the heavier weight of the two for the same reason it used to: it
 * is the one the customer will ask about. It only enters the score once something has actually
 * been assessed (`coverage > 0`), so an un-assessed checklist cannot silently halve a project.
 *
 * Projects whose customer has no checklist in the library — most of them — keep the older basis
 * (input readiness blended with approved outputs), because the alternative is scoring them on
 * approved documents alone and telling a PM who has just filled in a careful profile that they are
 * at 0%. `basis` reports which of the two produced the number, so no screen has to guess.
 */
async function projectReadiness(projectId: string) {
  const [values, documents, checklist] = await Promise.all([
    prisma.projectInputValue.findMany({ where: { projectId }, include: { definition: true } }),
    prisma.planningDocument.findMany({ where: { projectId } }),
    checklistScoreForProject(projectId),
  ]);

  const input = computeInputReadiness(
    values.map((value) => ({ value: value.value, verified: value.verified, required: value.definition.required })),
  );

  const generated = documents.filter((doc) => doc.status !== DocumentStatus.NOT_GENERATED).length;
  const approved = documents.filter((doc) => doc.status === DocumentStatus.APPROVED).length;
  const outputShare = documents.length ? Math.round((approved / documents.length) * 100) : 0;

  const ownScore = documents.length
    ? Math.round(input.readiness * 0.5 + outputShare * 0.5)
    : input.readiness;

  const checklistCounts = Boolean(checklist && checklist.coverage > 0);
  const readiness = checklistCounts
    ? documents.length
      ? Math.round(checklist!.score * 0.6 + outputShare * 0.4)
      : checklist!.score
    : ownScore;

  return {
    readiness,
    /**
     * What the number was actually built from, so the dashboard can name it rather than showing a
     * percentage with no stated meaning.
     */
    basis: checklistCounts
      ? documents.length
        ? ('CUSTOMER_AND_OUTPUTS' as const)
        : ('CUSTOMER' as const)
      : documents.length
        ? ('INPUT_AND_OUTPUTS' as const)
        : ('INPUT' as const),
    outputShare,
    /** Split out so the dashboard can show what moved the number, not just the number. */
    checklistReadiness: checklist ? { score: checklist.score, coverage: checklist.coverage, stale: checklist.stale } : null,
    inputReadiness: input.readiness,
    verifiedInputs: input.verified,
    totalInputs: input.total,
    documentsTotal: documents.length,
    documentsGenerated: generated,
    documentsApproved: approved,
    documentsInReview: documents.filter((doc) => doc.status === DocumentStatus.PM_REVIEW).length,
  };
}

/**
 * The program overview screen: every program, its projects, and roll-up health.
 *
 * Both delivery roles see the same board — isolation happens on `canOpen`: a PROJECT_OWNER may
 * only open the workspaces it owns or was granted membership on, while a PROGRAM_OWNER, who is
 * accountable for the whole program, may open any of them.
 */
export async function programOverview(user: { id: string; role: Role }) {
  const [programs, projects] = await Promise.all([
    prisma.program.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.project.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        program: true,
        members: { include: { user: { select: { id: true, initials: true, name: true } } } },
      },
    }),
  ]);

  const isProgramOwner = user.role === Role.PROGRAM_OWNER;

  const enriched = await Promise.all(
    projects.map(async (project) => {
      const stats = await projectReadiness(project.id);
      const [decision, openActions] = await Promise.all([
        prisma.approachDecision.findFirst({ where: { projectId: project.id, active: true } }),
        prisma.actionItem.count({ where: { projectId: project.id, status: 'OPEN' } }),
      ]);
      const membership = project.members.find((member) => member.userId === user.id);
      const isProjectOwner = project.ownerId === user.id;
      return {
        id: project.id,
        name: project.name,
        type: project.type,
        status: project.status,
        summary: project.summary,
        customer: project.customer,
        programId: project.programId,
        targetLabel: project.targetLabel,
        programKey: project.program?.key ?? 'standalone',
        programName: project.program?.name ?? 'Standalone',
        approach: decision?.approach ?? null,
        openDecisions: openActions,
        members: project.members.map((member) => member.user),
        canOpen: isProgramOwner || isProjectOwner || Boolean(membership),
        /** Rename, re-file, change status — anyone with the OWNER role inside the project. */
        canEdit: isProgramOwner || isProjectOwner || membership?.role === ProjectRole.OWNER,
        /** Deletion is irreversible, so it stays with the project's own owner (or the program owner). */
        canDelete: isProgramOwner || isProjectOwner,
        ...stats,
      };
    }),
  );

  const groups = [
    ...programs.map((program) => {
      const grouped = enriched.filter((project) => project.programKey === program.key);
      const active = grouped.filter((project) => project.status === ProjectStatus.ACTIVE);
      const rollup = active.length
        ? Math.round(active.reduce((sum, project) => sum + project.readiness, 0) / active.length)
        : null;
      return {
        key: program.key,
        id: program.id,
        name: program.name,
        description: program.description,
        targetOutcome: program.targetOutcome,
        colorKey: program.colorKey,
        readiness: rollup,
        health: rollup === null ? 'none' : rollup >= 75 ? 'good' : rollup >= 60 ? 'watch' : 'risk',
        projects: grouped,
      };
    }),
    {
      key: 'standalone',
      id: null,
      name: 'Standalone projects',
      description: 'Projects that do not belong to a program',
      targetOutcome: null,
      colorKey: 'none',
      readiness: null,
      health: 'none',
      projects: enriched.filter((project) => project.programKey === 'standalone'),
    },
  ];

  const active = enriched.filter((project) => project.status === ProjectStatus.ACTIVE);
  const mine = enriched.filter((project) => project.canOpen);
  const summary = {
    programs: programs.length,
    activePrograms: groups.filter((group) => group.health === 'good').length,
    activeProjects: active.length,
    myProjects: mine.length,
    byType: {
      SI: active.filter((project) => project.type === ProjectType.SI).length,
      SM: active.filter((project) => project.type === ProjectType.SM).length,
      PRODUCT: active.filter((project) => project.type === ProjectType.PRODUCT).length,
    },
    needsAttention: mine.filter((project) => project.openDecisions > 0).length,
    pendingDecisions: mine.reduce((sum, project) => sum + project.openDecisions, 0),
    deliveryReadiness: active.length
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

  return {
    capabilities: { canCreateProgram: isProgramOwner, canCreateProject: true, canOpenAll: isProgramOwner },
    summary,
    groups,
  };
}

/**
 * Creating a project provisions the type-specific input profile, the default
 * dashboard layout and the initial planning tasks — nothing is generated yet.
 * The creator becomes the project owner, which is what grants them workspace access.
 */
export async function createProject(params: {
  programId?: string | null;
  name: string;
  type: ProjectType;
  customer?: string;
  targetStart?: string;
  targetEnd?: string;
  ownerId: string;
}) {
  const definitions = await prisma.inputFieldDefinition.findMany({ where: { projectType: params.type } });

  // The name the PM typed in the create dialog is the same fact the form's first field asks for,
  // so seed it rather than making them type it twice. It counts as PM input, not a suggestion.
  const nameKeys = ['projectName', 'serviceName', 'productName'];

  const project = await prisma.project.create({
    data: {
      programId: params.programId || null,
      ownerId: params.ownerId,
      name: params.name,
      type: params.type,
      status: ProjectStatus.DRAFT,
      customer: params.customer,
      summary: `${params.type} workspace · Planning setup not started`,
      phaseLabel: `${params.type} · INITIATING`,
      targetStart: params.targetStart ? new Date(params.targetStart) : null,
      targetEnd: params.targetEnd ? new Date(params.targetEnd) : null,
      members: { create: { userId: params.ownerId, role: ProjectRole.OWNER } },
      inputValues: {
        create: definitions.map((definition) => ({
          definitionId: definition.id,
          value: nameKeys.includes(definition.key) ? params.name : null,
          source: ProjectInputSource.PM_INPUT,
          verified: false,
        })),
      },
      /**
       * No `tasks` are written any more. These four steps were stored here at `TODO` and then never
       * updated by anything — the dashboard now derives them from the project's real state
       * (`dashboard.service`), so writing a copy that immediately goes stale only creates something
       * for the two to disagree about. `PlanningTask` stays in the schema; nothing reads it.
       */
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
    /**
     * The field the customer reference library matches on. Omitting it here was a real defect:
     * it is what decides which checklist scores the project and whose template its kickoff deck
     * fills, so a workspace payload that hides it makes "why did nothing apply?" unanswerable.
     */
    customer: project.customer,
    /** Null means the PM has not decided — which is what puts the analysis into recommend mode. */
    preferredApproach: project.preferredApproach,
    phaseLabel: project.phaseLabel ?? `${project.type} · INITIATING`,
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

/** Invites an existing registered user onto a project — the only way an isolated project gains teammates. */
export async function addProjectMember(params: { projectId: string; email: string; role?: ProjectRole }) {
  const user = await prisma.user.findUnique({ where: { email: params.email.toLowerCase() } });
  if (!user) throw notFound('No user found with this email — they need to register first');
  if (user.role === Role.ADMIN) throw conflict('Administrator accounts cannot be added to a project');

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: params.projectId, userId: user.id } },
  });
  if (existing) throw conflict('This user is already a member of this project');

  return prisma.projectMember.create({
    data: { projectId: params.projectId, userId: user.id, role: params.role ?? ProjectRole.MEMBER },
    include: { user: { select: { id: true, name: true, initials: true, jobTitle: true } } },
  });
}

export async function removeProjectMember(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } });
  if (project?.ownerId === userId) throw conflict('The project owner cannot be removed from their own project');

  const existing = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
  if (!existing) throw notFound('This user is not a member of this project');
  await prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId } } });
  return { removed: true };
}
