import { Router } from 'express';
import { z } from 'zod';
import { ProjectStatus, ProjectType } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { PM_ROLES, requireRole } from '../../middleware/auth';
import { prisma } from '../../lib/prisma';
import {
  createPortfolio,
  createProgram,
  createProject,
  listPortfolios,
  portfolioOverview,
  projectWorkspace,
  updateProject,
} from './portfolio.service';

export const portfolioRouter = Router();

portfolioRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ portfolios: await listPortfolios() });
  }),
);

portfolioRouter.post(
  '/',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2),
        businessUnit: z.string().optional(),
        strategicObjective: z.string().optional(),
      }),
      req.body,
    );
    res.status(201).json(await createPortfolio({ ...body, ownerId: req.user!.id }));
  }),
);

portfolioRouter.get(
  '/:portfolioId/overview',
  asyncHandler(async (req, res) => {
    res.json(await portfolioOverview(req.params.portfolioId));
  }),
);

portfolioRouter.post(
  '/:portfolioId/programs',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2),
        description: z.string().optional(),
        targetOutcome: z.string().optional(),
      }),
      req.body,
    );
    res.status(201).json(
      await createProgram({ portfolioId: req.params.portfolioId, ...body, ownerId: req.user!.id }),
    );
  }),
);

portfolioRouter.post(
  '/:portfolioId/projects',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2),
        type: z.nativeEnum(ProjectType),
        programId: z.string().uuid().nullish(),
        customer: z.string().optional(),
        targetStart: z.string().optional(),
        targetEnd: z.string().optional(),
      }),
      req.body,
    );
    const project = await createProject({
      portfolioId: req.params.portfolioId,
      ...body,
      ownerId: req.user!.id,
    });
    res.status(201).json(await projectWorkspace(project.id));
  }),
);

export const projectRouter = Router();

projectRouter.get(
  '/:projectId',
  asyncHandler(async (req, res) => {
    res.json(await projectWorkspace(req.params.projectId));
  }),
);

projectRouter.patch(
  '/:projectId',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2).optional(),
        status: z.nativeEnum(ProjectStatus).optional(),
        summary: z.string().optional(),
        targetLabel: z.string().optional(),
        programId: z.string().uuid().nullish(),
      }),
      req.body,
    );
    const { programId, ...rest } = body;
    await updateProject(req.params.projectId, {
      ...rest,
      ...(programId === undefined ? {} : { program: programId ? { connect: { id: programId } } : { disconnect: true } }),
    });
    res.json(await projectWorkspace(req.params.projectId));
  }),
);

projectRouter.get(
  '/:projectId/members',
  asyncHandler(async (req, res) => {
    const members = await prisma.projectMember.findMany({
      where: { projectId: req.params.projectId },
      include: { user: { select: { id: true, name: true, initials: true, jobTitle: true } } },
    });
    res.json({ members });
  }),
);
