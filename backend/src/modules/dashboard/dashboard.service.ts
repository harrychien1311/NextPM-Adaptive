import { DocumentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/http-error';
import { listEvents } from '../audit/audit.service';
import { projectWorkspace } from '../program/program.service';
import { gapDocumentNames } from '../documents/documents.service';

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

  const [tasks, actions, domains, documents, references, activity, layout] = await Promise.all([
    prisma.planningTask.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
    prisma.actionItem.findMany({ where: { projectId, status: 'OPEN' }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
    prisma.domainReadiness.findMany({ where: { projectId } }),
    prisma.planningDocument.findMany({
      where: { projectId },
      select: { id: true, name: true, status: true, requirement: true, version: true, domain: true, generatedAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.referenceFile.findMany({ where: { projectId }, orderBy: { uploadedAt: 'desc' } }),
    listEvents(projectId, 8),
    prisma.dashboardLayout.findUnique({ where: { projectId_userId: { projectId, userId } } }),
  ]);

  /**
   * Document progress counts the documents this project is actually expected to produce — the ones
   * the planning analysis named as missing, plus the kickoff deck — not every row
   * `syncDocumentsWithPack` provisioned.
   *
   * Without this the dashboard reported "3/22 generated" for a project whose whole pack is five
   * documents, which reads as barely started when it is nearly done. Null means no analysis has
   * tied a gap to a document yet, and then the full pack is the honest denominator.
   */
  const gapNames = await gapDocumentNames(projectId);
  const inScope = gapNames ? documents.filter((doc) => gapNames.includes(doc.name)) : documents;

  const approved = inScope.filter((doc) => doc.status === DocumentStatus.APPROVED).length;
  const inReview = inScope.filter((doc) => doc.status === DocumentStatus.PM_REVIEW).length;
  const notGenerated = inScope.filter((doc) => doc.status === DocumentStatus.NOT_GENERATED).length;
  const requiredPending = inScope.filter(
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
      total: inScope.length,
      generated: inScope.length - notGenerated,
      approved,
      inReview,
      notGenerated,
      percent: inScope.length ? Math.round(((inScope.length - notGenerated) / inScope.length) * 100) : 0,
    },
    tasks: {
      items: tasks,
      complete: tasks.filter((task) => task.state === 'DONE').length,
      total: tasks.length,
    },
    actions,
    domains: domains.map((row) => ({ domain: row.domain, score: row.score, target: row.target })),
    /**
     * Every document attached to this project, whichever end it came from: files the PM uploaded
     * on the Input screen, and drafts the AI wrote in the Planning Studio. `origin` is what the
     * UI labels each row with, and `kind` tells it which preview to open.
     */
    library: [
      ...references.map((file) => ({
        id: file.id,
        kind: 'UPLOAD' as const,
        origin: 'PM_INPUT' as const,
        name: file.fileName,
        // DESCRIPTION is the dedicated project-description slot, not one of the reference tiles.
        category: file.group === 'DESCRIPTION' ? 'Project description' : `${file.group} reference`,
        status: file.status,
        sizeBytes: file.sizeBytes,
        at: file.uploadedAt,
      })),
      ...documents
        .filter((doc) => doc.status !== DocumentStatus.NOT_GENERATED)
        .map((doc) => ({
          id: doc.id,
          kind: 'GENERATED' as const,
          origin: 'AI_GENERATED' as const,
          name: `${doc.name} — v${doc.version}`,
          category: `${doc.domain} · ${doc.requirement === 'REQUIRED' ? 'Required' : 'Conditional'}`,
          status: doc.status,
          sizeBytes: null,
          at: doc.generatedAt,
        })),
    ],
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
