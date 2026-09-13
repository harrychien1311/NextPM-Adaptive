import bcrypt from 'bcryptjs';
import { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { conflict, forbidden, notFound } from '../../lib/http-error';
import { initialsOf } from '../../lib/slug';

/**
 * Account administration. This module is the ONLY place a Role is assigned by a human — in
 * particular PROGRAM_OWNER, which self-registration can never grant (see auth.service.register).
 * Administrators never read or write delivery data.
 */

const publicAccount = {
  id: true,
  email: true,
  name: true,
  initials: true,
  jobTitle: true,
  role: true,
  active: true,
  createdAt: true,
} as const;

export async function listAccounts() {
  const users = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    select: {
      ...publicAccount,
      _count: { select: { ownedProjects: true, memberships: true, ownedPrograms: true } },
    },
  });

  return {
    users: users.map((user) => ({
      ...user,
      ownedProjects: user._count.ownedProjects,
      memberships: user._count.memberships,
      ownedPrograms: user._count.ownedPrograms,
      _count: undefined,
    })),
    counts: {
      total: users.length,
      active: users.filter((user) => user.active).length,
      admins: users.filter((user) => user.role === Role.ADMIN).length,
      programOwners: users.filter((user) => user.role === Role.PROGRAM_OWNER).length,
      projectOwners: users.filter((user) => user.role === Role.PROJECT_OWNER).length,
    },
  };
}

export async function createAccount(params: {
  email: string;
  name: string;
  password: string;
  jobTitle?: string;
  role: Role;
}) {
  const email = params.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw conflict('This email is already registered');

  return prisma.user.create({
    data: {
      email,
      name: params.name,
      initials: initialsOf(params.name),
      jobTitle: params.jobTitle ?? 'Project Manager',
      role: params.role,
      passwordHash: await bcrypt.hash(params.password, 10),
    },
    select: publicAccount,
  });
}

export async function updateAccount(
  actorId: string,
  userId: string,
  data: { name?: string; jobTitle?: string; role?: Role; active?: boolean },
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('Account not found');

  // An administrator must not be able to lock themselves out of the console.
  if (userId === actorId && (data.role !== undefined || data.active === false)) {
    throw forbidden('You cannot change your own role or deactivate your own account');
  }
  if (user.role === Role.ADMIN && data.role && data.role !== Role.ADMIN) {
    const admins = await prisma.user.count({ where: { role: Role.ADMIN, active: true } });
    if (admins <= 1) throw conflict('The last administrator account cannot be demoted');
  }

  return prisma.user.update({ where: { id: userId }, data, select: publicAccount });
}

export async function resetPassword(userId: string, password: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound('Account not found');
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(password, 10) } });
  return { reset: true, email: user.email };
}

/**
 * Hard-deletes an account. Refused while the account still owns projects: deleting it would
 * leave those workspaces with no owner, so deactivation (which blocks sign-in) is the correct
 * action there.
 */
export async function deleteAccount(actorId: string, userId: string) {
  if (userId === actorId) throw forbidden('You cannot delete your own account');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, _count: { select: { ownedProjects: true } } },
  });
  if (!user) throw notFound('Account not found');

  if (user._count.ownedProjects > 0) {
    throw conflict(
      `This account owns ${user._count.ownedProjects} project workspace(s). Deactivate it instead, or reassign those projects first.`,
    );
  }
  if (user.role === Role.ADMIN) {
    const admins = await prisma.user.count({ where: { role: Role.ADMIN, active: true } });
    if (admins <= 1) throw conflict('The last administrator account cannot be deleted');
  }

  await prisma.user.delete({ where: { id: userId } });
  return { deleted: true };
}
