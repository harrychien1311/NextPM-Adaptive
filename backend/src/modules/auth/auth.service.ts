import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { conflict, unauthorized } from '../../lib/http-error';
import { signToken } from '../../middleware/auth';
import { initialsOf } from '../../lib/slug';

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !user.active) throw unauthorized('Invalid credentials');
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw unauthorized('Invalid credentials');
  return { token: signToken(user), user: publicUser(user) };
}

/**
 * Self-service sign-up. The role is hard-coded to PROJECT_OWNER and deliberately NOT taken from
 * the request body: PROGRAM_OWNER and ADMIN accounts may only be created by an administrator
 * through the admin console (modules/admin).
 */
export async function register(params: { email: string; name: string; password: string; jobTitle?: string }) {
  const existing = await prisma.user.findUnique({ where: { email: params.email.toLowerCase() } });
  if (existing) throw conflict('This email is already registered');
  const user = await prisma.user.create({
    data: {
      email: params.email.toLowerCase(),
      name: params.name,
      initials: initialsOf(params.name),
      jobTitle: params.jobTitle ?? 'Project Manager',
      role: Role.PROJECT_OWNER,
      passwordHash: await bcrypt.hash(params.password, 10),
    },
  });
  return { token: signToken(user), user: publicUser(user) };
}

export function publicUser(user: {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: Role;
  jobTitle: string;
  tutorialSeenAt: Date | null;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    initials: user.initials,
    role: user.role,
    jobTitle: user.jobTitle,
    tutorialSeenAt: user.tutorialSeenAt,
  };
}

/**
 * Records that the account has been through the first-run tutorial, so it stops opening by itself.
 * Idempotent: the first time is the one kept, and replaying the tutorial later changes nothing.
 */
export async function markTutorialSeen(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.tutorialSeenAt) return publicUser(user);
  return publicUser(await prisma.user.update({ where: { id: userId }, data: { tutorialSeenAt: new Date() } }));
}
