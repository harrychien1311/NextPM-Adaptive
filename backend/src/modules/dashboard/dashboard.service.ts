import { DocumentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/http-error';
import { listEvents } from '../audit/audit.service';
import { projectWorkspace } from '../portfolio/portfolio.service';

const DEFAULT_WIDGETS = {
  readiness: true,
  approach: true,
  outputs: true,
  tasks: true,
  decisions: true,
  domains: true,
  activity: true,
};

/** "One view. Every setup decision." — everything the control center renders. */
export async function dashboard(projectId: string, userId: string) {
  const workspace = await projectWorkspace(projectId);

  const [tasks, actions, domains, documents, activity, layout] = await Promise.all([
    prisma.planningTask.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
    prisma.actionItem.findMany({ where: { projectId, status: 'OPEN' }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
    prisma.domainReadiness.findMany({ where: { projectId } }),
    prisma.planningDocument.findMany({ where: { projectId }, select: { status: true, requirement: true, name: true } }),
    listEvents(projectId, 8),
    prisma.dashboardLayout.findUnique({ where: { projectId_userId: { projectId, userId } } }),
  ]);

  const approved = documents.filter((doc) => doc.status === DocumentStatus.APPROVED).length;
  const inReview = documents.filter((doc) => doc.status === DocumentStatus.PM_REVIEW).length;
  const notGenerated = documents.filter((doc) => doc.status === DocumentStatus.NOT_GENERATED).length;
  const requiredPending = documents.filter(
    (doc) => doc.requirement === 'REQUIRED' && doc.status !== DocumentStatus.APPROVED,
  ).length;

  const verdict =
    workspace.readiness >= 85 && requiredPending === 0
      ? { label: 'READY TO START', tone: 'green' }
      : workspace.readiness >= 55
        ? { label: 'GO WITH CONDITIONS', tone: 'amber' }
        : { label: 'NOT READY', tone: 'red' };

  return {
    workspace,
    startReadiness: {
      score: workspace.readiness,
      verdict,
      blockers: requiredPending,
      note: requiredPending
        ? `${requiredPending} required outputs await approval`
        : 'All required planning outputs are approved',
    },
    outputs: {
      total: documents.length,
      generated: documents.length - notGenerated,
      approved,
      inReview,
      notGenerated,
      percent: documents.length ? Math.round(((documents.length - notGenerated) / documents.length) * 100) : 0,
    },
    tasks: {
      items: tasks,
      complete: tasks.filter((task) => task.state === 'DONE').length,
      total: tasks.length,
    },
    actions,
    domains: domains.map((row) => ({ domain: row.domain, score: row.score, target: row.target })),
    activity,
    widgets: (layout?.widgets as Record<string, boolean>) ?? DEFAULT_WIDGETS,
  };
}

export async function saveLayout(projectId: string, userId: string, widgets: Record<string, boolean>) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');
  return prisma.dashboardLayout.upsert({
    where: { projectId_userId: { projectId, userId } },
    create: { projectId, userId, widgets: widgets as Prisma.InputJsonValue },
    update: { widgets: widgets as Prisma.InputJsonValue },
  });
}
