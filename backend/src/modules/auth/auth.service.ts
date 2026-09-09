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

export async function register(params: { email: string; name: string; password: string; role?: Role; jobTitle?: string }) {
  const existing = await prisma.user.findUnique({ where: { email: params.email.toLowerCase() } });
  if (existing) throw conflict('This email is already registered');
  const user = await prisma.user.create({
    data: {
      email: params.email.toLowerCase(),
      name: params.name,
      initials: initialsOf(params.name),
      jobTitle: params.jobTitle ?? 'Project Manager',
      role: params.role ?? Role.PROJECT_MANAGER,
      passwordHash: await bcrypt.hash(params.password, 10),
    },
  });
  return { token: signToken(user), user: publicUser(user) };
}

export function publicUser(user: { id: string; email: string; name: string; initials: string; role: Role; jobTitle: string }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    initials: user.initials,
    role: user.role,
    jobTitle: user.jobTitle,
  };
}
