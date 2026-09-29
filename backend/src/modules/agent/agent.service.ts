import { AgentRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { pmContextInputs } from '../../lib/custom-context';
import { forbidden, notFound } from '../../lib/http-error';
import { answerAgentQuestion, type AgentTurn } from '../ai/provider';
import { projectReadiness } from '../program/program.service';
import { latestAssessment } from '../assessment/assessment.service';
import { matchedChecklistForProject } from '../checklist/checklist.service';

/** How many earlier turns to replay. Enough for a real follow-up, bounded so cost stays flat. */
const HISTORY_TURNS = 12;

/** Chat sessions are private to the user who held them, like project access itself. */
async function ownedSession(sessionId: string, projectId: string, userId: string) {
  const session = await prisma.agentSession.findFirst({ where: { id: sessionId, projectId } });
  if (!session) throw notFound('Chat not found');
  // A legacy session (userId null) is readable by any project member; a real one is not.
  if (session.userId && session.userId !== userId) throw forbidden('This chat belongs to another user');
  return session;
}

export async function listSessions(projectId: string, userId: string) {
  return prisma.agentSession.findMany({
    where: { projectId, OR: [{ userId }, { userId: null }] },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
}

export async function createSession(projectId: string, userId: string) {
  return prisma.agentSession.create({ data: { projectId, userId } });
}

export async function sessionMessages(sessionId: string, projectId: string, userId: string) {
  await ownedSession(sessionId, projectId, userId);
  return prisma.agentMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
}

export async function renameSession(sessionId: string, projectId: string, userId: string, title: string) {
  await ownedSession(sessionId, projectId, userId);
  return prisma.agentSession.update({ where: { id: sessionId }, data: { title } });
}

export async function deleteSession(sessionId: string, projectId: string, userId: string) {
  await ownedSession(sessionId, projectId, userId);
  await prisma.agentSession.delete({ where: { id: sessionId } });
  return { deleted: true };
}

/** What each readiness basis means, in the words the agent can repeat to the PM. */
const BASIS_TEXT = {
  CUSTOMER_AND_FPT: '60% customer standard + 40% FPT standard',
  FPT_ONLY: 'the FPT standard alone — no customer checklist has been assessed for this project',
  CUSTOMER_AND_OUTPUTS: '60% customer standard + 40% share of approved documents — the Planning Assessment has not been run yet',
  NOT_ASSESSED: 'the share of approved documents only — the Planning Assessment has not been run yet',
} as const;

/** How many recent plan changes the agent is shown. */
const RECENT_PLAN_CHANGES = 5;

/** How many findings of each Planning Assessment category are named; the counts are always complete. */
const FINDINGS_PER_CATEGORY = 12;

/**
 * The figures the dashboard shows, for the agent. Built by the same functions the dashboard calls
 * (`projectReadiness`, `latestAssessment`), so the agent can never quote a different number than the
 * tile the PM is looking at. The agent used to be given none of this, and its prompt tells it to use
 * only the data it is given — so asked about Planning readiness, it truthfully said there was no such
 * figure.
 */
export async function readinessContext(projectId: string): Promise<string[]> {
  const [readiness, assessment, checklist] = await Promise.all([
    projectReadiness(projectId),
    latestAssessment(projectId),
    matchedChecklistForProject(projectId).catch(() => null),
  ]);

  const fpt = assessment?.standards.fpt;
  const customer = assessment?.standards.customer;
  const lines = [
    'PLANNING READINESS & STANDARDS (the same figures the dashboard shows)',
    `- Planning readiness: ${readiness.readiness}%, computed as ${BASIS_TEXT[readiness.basis]}.`,
    '- Formula: 60% customer standard + 40% FPT standard; the FPT standard alone when no customer checklist is assessed.',
    fpt
      ? `- FPT standard: ${fpt.score}% — ${fpt.met} of ${fpt.assessed} judged criteria met (Missing Information + Missing Documents; criteria the input could not judge are left out).`
      : '- FPT standard: not measured yet — the Planning Assessment has never been run (Analyze planning needs on Project Input).',
    customer
      ? `- ${customer.label}: ${customer.score}% (${customer.coverage}% of the checklist assessed${customer.stale ? ', out of date since the documents changed' : ''}).`
      : checklist
        ? `- Customer standard (${checklist.customer.name}, ${checklist.checklist.itemCount} items): not assessed yet, so it is not in the figure.`
        : '- Customer standard: no checklist in the library for this project’s customer, so it is not in the figure.',
    `- Planning artifacts: ${readiness.artifactsApproved} of ${readiness.artifactsNeeded} needed documents approved; ${readiness.documentsGenerated} of ${readiness.documentsTotal} catalog documents generated.`,
    `- Input readiness (the intake form, not part of Planning readiness): ${readiness.inputReadiness}%.`,
  ];

  if (!assessment) return lines;

  const failing = (category: string) => assessment.rows.filter((row) => row.category === category && row.status === 'FAIL');
  const named = (rows: ReturnType<typeof failing>, describe: (row: (typeof rows)[number]) => string) => [
    ...rows.slice(0, FINDINGS_PER_CATEGORY).map((row) => `  - ${describe(row)}`),
    ...(rows.length > FINDINGS_PER_CATEGORY ? [`  - …and ${rows.length - FINDINGS_PER_CATEGORY} more`] : []),
  ];
  // A PM's own "not met" outranks an approved document, so the agent must be able to say why a row
  // whose document is approved is still missing.
  const byPm = (row: ReturnType<typeof failing>[number]) => (row.pmVerdict === 'NOT_MET' ? ' — marked not met by the PM' : '');
  const information = failing('MISSING_INFORMATION');
  const missingDocuments = failing('MISSING_DOCUMENT');
  const risks = failing('PLANNING_RISK');
  const conflicts = failing('CONFLICT');

  return [
    ...lines,
    '',
    `PLANNING ASSESSMENT (latest run ${assessment.at.toISOString().slice(0, 10)}; resolved items already excluded)`,
    `- Missing information: ${information.length}`,
    ...named(information, (row) => `${row.name}${row.action ? ` — ${row.action}` : ''}${byPm(row)}`),
    `- Missing documents: ${missingDocuments.length}`,
    ...named(
      missingDocuments,
      (row) =>
        `${row.name}${row.targetDocument ? ` → ${row.targetDocument} (${row.targetDocumentStatus ?? 'NOT_GENERATED'})` : ''}${byPm(row)}`,
    ),
    `- Risks found: ${risks.length}`,
    ...named(risks, (row) => `[${row.severity}] ${row.name}`),
    `- Conflicts found: ${conflicts.length}`,
    ...named(conflicts, (row) => `[${row.severity}] ${row.name}`),
  ];
}

/**
 * Everything the agent is allowed to know about this project.
 *
 * Passed in full rather than retrieved by similarity search: a whole project is a few tens of
 * thousands of tokens against a 1M-token context window, so there is nothing to retrieve *from*.
 * Sending it directly is both cheaper to build and more accurate than any nearest-neighbour
 * lookup, which can always pick the wrong passage.
 */
export async function projectContext(projectId: string, question: string) {
  const [project, decision, evaluation, values, documents, actions, customContext, figures, changes] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, include: { program: true } }),
    prisma.approachDecision.findFirst({ where: { projectId, active: true } }),
    prisma.aiApproachSuggestion.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
    prisma.projectInputValue.findMany({ where: { projectId }, include: { definition: true } }),
    prisma.planningDocument.findMany({
      where: { projectId },
      include: { sections: { orderBy: { order: 'asc' } } },
      orderBy: { name: 'asc' },
    }),
    prisma.actionItem.findMany({ where: { projectId, status: 'OPEN' } }),
    pmContextInputs(projectId),
    readinessContext(projectId),
    // The recent plan changes, so "why is this document out of date?" can be traced to the change.
    prisma.planChange.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: RECENT_PLAN_CHANGES,
      select: { status: true, note: true, createdAt: true, appliedAt: true, _count: { select: { documents: true } } },
    }),
  ]);
  if (!project) throw notFound('Project not found');

  const line = (label: string, value: unknown) => `- ${label}: ${value ?? '—'}`;

  const inputs = [
    ...values
      .filter((value) => value.value)
      .map((value) => `- ${value.definition.label}: ${value.value}${value.verified ? '' : '  (NOT YET VERIFIED)'}`),
    ...customContext.map((entry) => `- ${entry.label}: ${entry.value}`),
  ];

  /**
   * One line per document, with what the Studio shows about it: status and version, when it was
   * approved, and — the part the agent used to be blind to — whether a plan change marked it out of
   * date, since when and why. Without the flag here, "which documents are out of date?" had no
   * answer in the data the agent is told to use exclusively.
   */
  const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
  const docList = documents.map((doc) =>
    [
      `- ${doc.name} — ${doc.status}${doc.status !== 'NOT_GENERATED' ? ` (v${doc.version})` : ''}`,
      doc.status === 'APPROVED' && doc.approvedAt ? `, approved ${day(doc.approvedAt)}` : '',
      doc.staleReason
        ? ` — OUT OF DATE after a plan change${doc.staleSince ? ` (since ${day(doc.staleSince)})` : ''}: ${doc.staleReason}`
        : '',
    ].join(''),
  );
  const outOfDate = documents.filter((doc) => doc.staleReason).length;

  const changeList = changes.map((change) =>
    [
      `- ${day(change.appliedAt ?? change.createdAt)} · ${change.status}`,
      change._count.documents ? ` · ${change._count.documents} document(s)` : '',
      change.note?.trim() ? ` · "${change.note.trim().slice(0, 200)}"` : '',
    ].join(''),
  );

  // Full text only for the document the question actually names — the rest stay as a listing, so
  // an unrelated question does not drag 16 documents' prose into the prompt.
  const named = documents.filter(
    (doc) => doc.status !== 'NOT_GENERATED' && question.toLowerCase().includes(doc.name.toLowerCase()),
  );
  const docBodies = named.map((doc) =>
    [
      `--- ${doc.name} (v${doc.version}, ${doc.status}) ---`,
      ...doc.sections.filter((s) => s.included && s.content).map((s) => `## ${s.title}\n${s.content}`),
    ].join('\n'),
  );

  return [
    'PROJECT',
    line('Name', project.name),
    line('Project type', `${project.category ?? 'not set (earlier type)'} — plans with the ${project.type} document catalog`),
    line('Status', project.status),
    line('Program', project.program?.name ?? 'Standalone'),
    line('Customer', project.customer),
    '',
    'GOVERNANCE MODEL',
    line('Confirmed model', decision ? `${decision.approach} (${decision.rigor}, ${decision.outcome})` : 'not confirmed yet'),
    line('AI recommendation', evaluation ? `${evaluation.recommendedApproach} at ${evaluation.confidence}%` : 'none yet'),
    line('Reasons', ((evaluation?.reasons ?? []) as unknown as string[]).join('; ') || '—'),
    '',
    ...figures,
    '',
    `PROJECT INPUTS (${values.filter((v) => v.verified && v.value).length} verified of ${values.length})`,
    ...(inputs.length ? inputs : ['- none filled in yet']),
    '',
    `OPEN ACTIONS (${actions.length})`,
    ...(actions.length ? actions.map((a) => `- [${a.priority}] ${a.title}`) : ['- none']),
    '',
    `PLANNING DOCUMENTS (${outOfDate} out of date after a plan change; regenerate one in Planning Artifacts to clear the flag)`,
    ...(docList.length ? docList : ['- none in the catalog yet']),
    '',
    `PLAN CHANGES (latest ${RECENT_PLAN_CHANGES}, newest first; an APPLIED change is what marks documents out of date — Update Planning / Plan History)`,
    ...(changeList.length ? changeList : ['- none recorded']),
    ...(docBodies.length ? ['', 'FULL TEXT OF THE DOCUMENT(S) THIS QUESTION NAMES', ...docBodies] : []),
  ].join('\n');
}

/**
 * The planning agent verifies, recommends and drafts. It never applies a decision:
 * every reply is advisory until the PM confirms it in the UI.
 */
export async function ask(params: { projectId: string; sessionId: string; userId: string; question: string }) {
  const { projectId, sessionId, userId, question } = params;
  const session = await ownedSession(sessionId, projectId, userId);

  const priorMessages = await prisma.agentMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_TURNS * 2,
  });
  const history: AgentTurn[] = priorMessages
    .reverse()
    .map((message) => ({ role: message.role === AgentRole.USER ? 'user' : 'assistant', content: message.content }));

  const userMessage = await prisma.agentMessage.create({
    data: { projectId, sessionId, role: AgentRole.USER, content: question },
  });

  const content = await answerAgentQuestion({
    projectContext: await projectContext(projectId, question),
    history,
    question,
  });

  const agentMessage = await prisma.agentMessage.create({
    data: { projectId, sessionId, role: AgentRole.AGENT, content, meta: { decisionApplied: false } },
  });

  // First question names the chat, the way a chat app titles a thread from its opening line.
  const title =
    session.title === 'New chat' && !priorMessages.length
      ? question.length > 60 ? `${question.slice(0, 57)}…` : question
      : session.title;

  await prisma.agentSession.update({ where: { id: sessionId }, data: { title, updatedAt: new Date() } });

  return { userMessage, agentMessage, title };
}
