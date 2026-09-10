import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '@prisma/client';
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
      projectRole?: Role;
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

/** Only these roles may confirm approaches / approve baselines. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

export const PM_ROLES: Role[] = [Role.ADMIN, Role.PORTFOLIO_MANAGER, Role.PROJECT_MANAGER];

/**
 * Isolates projects per user: mount with `router.use('/:projectId', requireProjectMember)` on
 * every project-scoped router. ADMIN and the owner of the project's portfolio always pass (and
 * are treated as PORTFOLIO_MANAGER-tier for requireProjectRole below); everyone else must be a
 * ProjectMember row for this exact project. Sets req.projectRole for requireProjectRole to read.
 */
export async function requireProjectMember(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorized());
  if (req.user.role === Role.ADMIN) {
    req.projectRole = Role.ADMIN;
    return next();
  }

  const projectId = req.params.projectId;
  const [project, membership] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { portfolio: { select: { ownerId: true } } } }),
    prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: req.user.id } } }),
  ]);
  if (!project) return next(notFound('Project not found'));

  if (project.portfolio.ownerId === req.user.id) {
    req.projectRole = Role.PORTFOLIO_MANAGER;
    return next();
  }
  if (!membership) return next(forbidden('You are not a member of this project'));

  req.projectRole = membership.role;
  next();
}

/** For :projectId routes, after requireProjectMember: checks the requester's role within THIS project. */
export const requireProjectRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!req.projectRole) return next(forbidden('Project membership was not resolved'));
    if (!roles.includes(req.projectRole)) return next(forbidden());
    next();
  };
