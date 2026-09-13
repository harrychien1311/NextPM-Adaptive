import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ProjectRole, Role } from '@prisma/client';
import { env } from '../config/env';
import { forbidden, notFound, unauthorized } from '../lib/http-error';
import { prisma } from '../lib/prisma';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** The requester's effective role within the :projectId of this request — set by requireProjectMember. */
      projectRole?: ProjectRole;
    }
  }
}

export function signToken(user: { id: string; email: string; role: Role }) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  } as jwt.SignOptions);
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) throw unauthorized('User is no longer active');
    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      initials: user.initials,
      role: user.role,
    };
    next();
  } catch (error) {
    next(error instanceof Error && error.name === 'JsonWebTokenError' ? unauthorized('Invalid token') : error);
  }
}

/** Account-role gate (global). ADMIN is an account-administration role, not a delivery role. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

/** Roles allowed to create a project workspace: the program owner, and any project owner. */
export const PROJECT_CREATOR_ROLES: Role[] = [Role.PROGRAM_OWNER, Role.PROJECT_OWNER];

/** Within a project, only OWNER may change planning state; MEMBER/VIEWER are read-only. */
export const PROJECT_WRITE_ROLES: ProjectRole[] = [ProjectRole.OWNER];

/**
 * Isolates projects per user: mount with `router.use('/:projectId', requireProjectMember)` on
 * every project-scoped router.
 *
 * - PROGRAM_OWNER oversees the whole delivery org, so it passes for any project as OWNER.
 * - The project's own owner passes as OWNER even without a membership row.
 * - Everyone else must have a ProjectMember row for this exact project.
 * - ADMIN deliberately does NOT pass: administrators manage accounts, never delivery content.
 */
export async function requireProjectMember(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role === Role.ADMIN) {
    return next(forbidden('Administrator accounts manage users only, not project workspaces'));
  }

  const projectId = req.params.projectId;
  const [project, membership] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { ownerId: true } }),
    prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: req.user.id } } }),
  ]);
  if (!project) return next(notFound('Project not found'));

  if (req.user.role === Role.PROGRAM_OWNER || project.ownerId === req.user.id) {
    req.projectRole = ProjectRole.OWNER;
    return next();
  }
  if (!membership) return next(forbidden('You are not a member of this project'));

  req.projectRole = membership.role;
  next();
}

/** For :projectId routes, after requireProjectMember: checks the requester's role within THIS project. */
export const requireProjectRole =
  (...roles: ProjectRole[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!req.projectRole) return next(forbidden('Project membership was not resolved'));
    if (!roles.includes(req.projectRole)) return next(forbidden());
    next();
  };
