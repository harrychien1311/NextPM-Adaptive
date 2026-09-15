import { Router } from 'express';
import { z } from 'zod';
import { ChecklistStatus } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { PROJECT_WRITE_ROLES, requireProjectMember, requireProjectRole } from '../../middleware/auth';
import { checklistReadiness, runChecklistAssessment, setItemVerdict } from './checklist.service';

export const checklistRouter = Router();
checklistRouter.use('/:projectId', requireProjectMember);

checklistRouter.get(
  '/:projectId/checklist',
  asyncHandler(async (req, res) => {
    res.json(await checklistReadiness(req.params.projectId));
  }),
);

/**
 * Runs the assessment and waits for it. This is the PM pressing a button and watching, so a
 * spinner is the right answer; the automatic re-run after a document approval is the one that
 * happens in the background (see documents.service).
 */
checklistRouter.post(
  '/:projectId/checklist/assess',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ onlyUnmet: z.boolean().optional() }), req.body ?? {});
    const result = await runChecklistAssessment({
      projectId: req.params.projectId,
      actorId: req.user!.id,
      onlyUnmet: body.onlyUnmet ?? false,
    });
    res.json({ ...result, readiness: await checklistReadiness(req.params.projectId) });
  }),
);

/** The PM's own verdict on one item — outranks the deterministic pass and the model. */
checklistRouter.post(
  '/:projectId/checklist/items/:itemId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ status: z.nativeEnum(ChecklistStatus), note: z.string().max(600).optional() }),
      req.body,
    );
    await setItemVerdict({
      projectId: req.params.projectId,
      checklistItemId: req.params.itemId,
      status: body.status,
      note: body.note ?? null,
      actorId: req.user!.id,
    });
    res.json(await checklistReadiness(req.params.projectId));
  }),
);
