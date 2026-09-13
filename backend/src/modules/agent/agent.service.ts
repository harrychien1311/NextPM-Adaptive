import { AgentRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { forbidden, notFound } from '../../lib/http-error';
import { answerAgentQuestion, type AgentTurn } from '../ai/provider';

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

/**
 * Everything the agent is allowed to know about this project.
 *
 * Passed in full rather than retrieved by similarity search: a whole project is a few tens of
 * thousands of tokens against a 1M-token context window, so there is nothing to retrieve *from*.
 * Sending it directly is both cheaper to build and more accurate than any nearest-neighbour
 * lookup, which can always pick the wrong passage.
 */
async function projectContext(projectId: string, question: string) {
  const [project, decision, evaluation, values, documents, actions] = await Promise.all([
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
  ]);
  if (!project) throw notFound('Project not found');

  const line = (label: string, value: unknown) => `- ${label}: ${value ?? '—'}`;

  const inputs = values
    .filter((value) => value.value)
    .map((value) => `- ${value.definition.label}: ${value.value}${value.verified ? '' : '  (NOT YET VERIFIED)'}`);

  const docList = documents.map(
    (doc) => `- ${doc.name} — ${doc.status}${doc.status !== 'NOT_GENERATED' ? ` (v${doc.version})` : ''}`,
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
    line('Type', project.type),
    line('Status', project.status),
    line('Program', project.program?.name ?? 'Standalone'),
    line('Customer', project.customer),
    '',
    'GOVERNANCE MODEL',
    line('Confirmed model', decision ? `${decision.approach} (${decision.rigor}, ${decision.outcome})` : 'not confirmed yet'),
    line('AI recommendation', evaluation ? `${evaluation.recommendedApproach} at ${evaluation.confidence}%` : 'none yet'),
    line('Reasons', ((evaluation?.reasons ?? []) as unknown as string[]).join('; ') || '—'),
    '',
    `PROJECT INPUTS (${values.filter((v) => v.verified && v.value).length} verified of ${values.length})`,
    ...(inputs.length ? inputs : ['- none filled in yet']),
    '',
    `OPEN ACTIONS (${actions.length})`,
    ...(actions.length ? actions.map((a) => `- [${a.priority}] ${a.title}`) : ['- none']),
    '',
    'PLANNING DOCUMENTS',
    ...(docList.length ? docList : ['- none in the catalog yet']),
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
