import { AgentRole } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { notFound } from '../../lib/http-error';
import { answerAgentQuestion } from '../ai/provider';

export async function history(projectId: string, limit = 40) {
  return prisma.agentMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
}

/**
 * The planning agent verifies, recommends and drafts. It never applies a decision:
 * every reply is advisory until the PM confirms it in the UI.
 */
export async function ask(params: { projectId: string; question: string }) {
  const project = await prisma.project.findUnique({ where: { id: params.projectId } });
  if (!project) throw notFound('Project not found');

  const [evaluation, decision, verifiedCount, missingCount] = await Promise.all([
    prisma.aiApproachSuggestion.findFirst({ where: { projectId: params.projectId }, orderBy: { createdAt: 'desc' } }),
    prisma.approachDecision.findFirst({ where: { projectId: params.projectId, active: true } }),
    prisma.projectInputValue.count({ where: { projectId: params.projectId, verified: true, NOT: { value: null } } }),
    prisma.actionItem.count({ where: { projectId: params.projectId, status: 'OPEN' } }),
  ]);
  const reasons = ((evaluation?.reasons ?? []) as unknown as string[]) ?? [];

  const userMessage = await prisma.agentMessage.create({
    data: { projectId: params.projectId, role: AgentRole.USER, content: params.question },
  });

  const content = await answerAgentQuestion({
    projectName: project.name,
    approach: decision?.approach ?? evaluation?.recommendedApproach ?? 'not selected',
    question: params.question,
    verifiedCount,
    missingCount,
    reasons,
  });

  const agentMessage = await prisma.agentMessage.create({
    data: {
      projectId: params.projectId,
      role: AgentRole.AGENT,
      content,
      meta: {
        verifiedInputs: verifiedCount,
        missingValues: missingCount,
        reasons,
        decisionApplied: false,
      },
    },
  });

  return { userMessage, agentMessage };
}
