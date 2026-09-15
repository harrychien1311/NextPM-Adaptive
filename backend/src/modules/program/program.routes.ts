import { Router } from 'express';
import { z } from 'zod';
import { ProjectRole, ProjectStatus, ProjectType, Role } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import {
  PROJECT_CREATOR_ROLES,
  PROJECT_WRITE_ROLES,
  requireProjectMember,
  requireProjectRole,
  requireRole,
} from '../../middleware/auth';
import { prisma } from '../../lib/prisma';
import {
  addProjectMember,
  createProgram,
  createProject,
  deleteProgram,
  deleteProject,
  programOverview,
  projectWorkspace,
  removeProjectMember,
  updateProgram,
  updateProject,
} from './program.service';

export const programRouter = Router();

/** The delivery landing screen. Administrators manage accounts and have no view here. */
programRouter.get(
  '/overview',
  requireRole(...PROJECT_CREATOR_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await programOverview(req.user!));
  }),
);

programRouter.post(
  '/',
  requireRole(Role.PROGRAM_OWNER),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2),
        description: z.string().optional(),
        targetOutcome: z.string().optional(),
      }),
      req.body,
    );
    res.status(201).json(await createProgram({ ...body, ownerId: req.user!.id }));
  }),
);

programRouter.patch(
  '/:programId',
  requireRole(Role.PROGRAM_OWNER),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2).optional(),
        description: z.string().nullish(),
        targetOutcome: z.string().nullish(),
      }),
      req.body,
    );
    res.json(await updateProgram(req.params.programId, body));
  }),
);

/** Deleting a program releases its projects to standalone; it never deletes a project. */
programRouter.delete(
  '/:programId',
  requireRole(Role.PROGRAM_OWNER),
  asyncHandler(async (req, res) => {
    res.json(await deleteProgram(req.params.programId));
  }),
);

export const projectRouter = Router();

/** Both delivery roles may create a project; the creator becomes its owner. */
projectRouter.post(
  '/',
  requireRole(...PROJECT_CREATOR_ROLES),
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
    const project = await createProject({ ...body, ownerId: req.user!.id });
    res.status(201).json(await projectWorkspace(project.id));
  }),
);

projectRouter.use('/:projectId', requireProjectMember);

projectRouter.get(
  '/:projectId',
  asyncHandler(async (req, res) => {
    /**
     * `projectRole` rides along so the workspace can show a reader a read-only screen instead of
     * controls that 403 when pressed. It is reported, never trusted: every write route still runs
     * `requireProjectRole` — this only saves a VIEWER from being invited to do something the
     * server will refuse.
     */
    res.json({ ...(await projectWorkspace(req.params.projectId)), projectRole: req.projectRole ?? null });
  }),
);

projectRouter.patch(
  '/:projectId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2).optional(),
        status: z.nativeEnum(ProjectStatus).optional(),
        summary: z.string().optional(),
        customer: z.string().optional(),
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

/**
 * Irreversible: every input, upload, recommendation, decision, document and audit row for this
 * project cascades away. Restricted to the project's owner or the program owner (checked in the
 * service), which is stricter than the OWNER project role that may edit.
 */
projectRouter.delete(
  '/:projectId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await deleteProject(req.params.projectId, req.user!));
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

/** Invite an existing user (by email) onto this project — this is how isolated projects gain teammates. */
projectRouter.post(
  '/:projectId/members',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email: z.string().email(), role: z.nativeEnum(ProjectRole).optional() }), req.body);
    res.status(201).json(await addProjectMember({ projectId: req.params.projectId, email: body.email, role: body.role }));
  }),
);

projectRouter.delete(
  '/:projectId/members/:userId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await removeProjectMember(req.params.projectId, req.params.userId));
  }),
);
