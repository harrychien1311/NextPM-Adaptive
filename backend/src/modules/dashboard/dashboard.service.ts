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

  const [actions, domains, documents, references, activity, layout] = await Promise.all([
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
  /**
   * What the Studio has done with the document each action points at.
   *
   * An action says "there is no escalation path"; pressing *PM confirm* on the Change / Escalation
   * Flow is the PM answering it. The action center could not see that — the two lived side by side
   * with no connection — so a PM who had just confirmed the document still read "No incident and
   * change escalation path" on their dashboard as though nothing had happened.
   *
   * It is reported, not acted on: the row is marked ready to close and the PM closes it. Resolving
   * it automatically would be the agent deciding on the PM's behalf, which is the one thing this
   * application does not do — and approving a document is not always the same claim as closing the
   * gap that asked for it.
   */
  const documentStatusByName = new Map(documents.map((doc) => [doc.name.trim().toLowerCase(), doc.status]));
  const actionRows = actions.map((action) => ({
    ...action,
    targetDocumentStatus: action.targetDocument
      ? documentStatusByName.get(action.targetDocument.trim().toLowerCase()) ?? null
      : null,
  }));

  const gapNames = await gapDocumentNames(projectId);
  const inScope = gapNames ? documents.filter((doc) => gapNames.includes(doc.name)) : documents;

  const approved = inScope.filter((doc) => doc.status === DocumentStatus.APPROVED).length;
  const inReview = inScope.filter((doc) => doc.status === DocumentStatus.PM_REVIEW).length;
  const notGenerated = inScope.filter((doc) => doc.status === DocumentStatus.NOT_GENERATED).length;
  const requiredPending = inScope.filter(
    (doc) => doc.requirement === 'REQUIRED' && doc.status !== DocumentStatus.APPROVED,
  ).length;

  /**
   * The four steps of the planning flow, **derived** — never stored.
   *
   * They used to be `PlanningTask` rows written once when the project was provisioned, all four at
   * `TODO`, and the only code that ever moved one was `verifyInputs`, matching on the single title
   * "Complete minimum project profile". That button was removed from Project Input when
   * `analyzePlanningNeeds` replaced it, so nothing has updated a task since — a project with an
   * analysis, a confirmed governance model and approved documents still reported four outstanding
   * to-dos. Steps 2-4 never had an update path at all, in any version.
   *
   * A stored mirror of state that something else owns drifts the moment anyone forgets to update
   * it, and nobody finds out. Every fact below is already loaded for the panels above, so this costs
   * no extra query and cannot disagree with them.
   */
  const descriptionReadable = references.some(
    (file) => file.group === 'DESCRIPTION' && (file.extraction as { textAvailable?: boolean } | null)?.textAvailable,
  );
  // The same three items Project Input counts in its "Required inputs 2/3" meter — the two screens
  // must not give the PM different answers about whether the profile is complete.
  const requiredInputs = [Boolean(workspace.name?.trim()), Boolean(workspace.type), descriptionReadable];
  const requiredDone = requiredInputs.filter(Boolean).length;

  const generated = inScope.length - notGenerated;
  const planningTasks = [
    {
      id: 'profile',
      title: 'Complete minimum project profile',
      detail: `${requiredDone}/${requiredInputs.length} required inputs`,
      state: requiredDone === requiredInputs.length ? 'DONE' : 'TODO',
      order: 0,
    },
    {
      id: 'analysis',
      // Named after the button that exists. The old title said "Verify inputs & get AI
      // recommendation", which is two buttons that were both deleted.
      title: 'Analyze planning needs',
      detail: workspace.recommendation
        ? `${workspace.recommendation.approach} · ${workspace.recommendation.confidence}% fit`
        : 'Reads the uploaded documents in one pass',
      state: workspace.recommendation ? 'DONE' : 'TODO',
      order: 1,
    },
    {
      id: 'decision',
      title: 'Confirm governance model',
      detail: workspace.approach ? `${workspace.approach.approach} · ${workspace.approach.outcome}` : 'PM decision gate',
      state: workspace.approach ? 'DONE' : 'TODO',
      order: 2,
    },
    {
      id: 'documents',
      title: 'Generate & approve planning pack',
      detail: inScope.length ? `${approved}/${inScope.length} approved` : 'AI drafts, PM approves',
      // REVIEW, not DONE, while drafts exist that nobody has approved: generating is not finishing,
      // and the whole point of the approval step is that it is a separate decision.
      state: inScope.length && approved === inScope.length ? 'DONE' : generated ? 'REVIEW' : 'TODO',
      order: 3,
    },
  ];

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
      items: planningTasks,
      complete: planningTasks.filter((task) => task.state === 'DONE').length,
      total: planningTasks.length,
    },
    actions: actionRows,
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
