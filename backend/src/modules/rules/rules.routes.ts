import { Router } from 'express';
import { z } from 'zod';
import { DecisionOutcome } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { PM_ROLES, requireProjectMember, requireProjectRole } from '../../middleware/auth';
import { activeDecision, approachOptions, decideApproach, latestEvaluation, runEvaluation } from './rules.service';

export const rulesRouter = Router();
rulesRouter.use('/:projectId', requireProjectMember);

/** Read the current recommendation, scored alternatives and PM decision state. */
rulesRouter.get(
  '/:projectId/approach',
  asyncHandler(async (req, res) => {
    const [evaluation, options, decision] = await Promise.all([
      latestEvaluation(req.params.projectId),
      approachOptions(req.params.projectId),
      activeDecision(req.params.projectId),
    ]);
    res.json({ evaluation, options, decision });
  }),
);

/** Asks the AI (Skill 1) to recommend a governance model from verified inputs + the project description document. */
rulesRouter.post(
  '/:projectId/approach/evaluate',
  requireProjectRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await runEvaluation(req.params.projectId, req.user!.id));
  }),
);

/** The PM decision gate: confirm the recommendation, or override with a reason. */
rulesRouter.post(
  '/:projectId/approach/decide',
  requireProjectRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        approach: z.string().min(1),
        outcome: z.nativeEnum(DecisionOutcome).optional(),
        rationale: z.string().max(2000).optional(),
      }),
      req.body,
    );
    res.status(201).json(
      await decideApproach({
        projectId: req.params.projectId,
        approach: body.approach,
        outcome: body.outcome ?? DecisionOutcome.CONFIRMED,
        rationale: body.rationale,
        decidedById: req.user!.id,
      }),
    );
  }),
);
