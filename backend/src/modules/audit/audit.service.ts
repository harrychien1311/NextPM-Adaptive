import { ActorType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';

/** Every rule run, generation and PM decision is traceable. */
export async function logEvent(params: {
  projectId: string;
  actorId?: string | null;
  actorType?: ActorType;
  type: string;
  title: string;
  detail?: string | null;
  payload?: unknown;
}) {
  return prisma.auditEvent.create({
    data: {
      projectId: params.projectId,
      actorId: params.actorId ?? null,
      actorType: params.actorType ?? ActorType.PM,
      type: params.type,
      title: params.title,
      detail: params.detail ?? null,
      payload: (params.payload ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function listEvents(projectId: string, limit = 30) {
  return prisma.auditEvent.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { actor: { select: { id: true, name: true, initials: true } } },
  });
}
