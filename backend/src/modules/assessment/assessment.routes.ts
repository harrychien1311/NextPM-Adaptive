import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { PROJECT_WRITE_ROLES, requireProjectMember, requireProjectRole } from '../../middleware/auth';
import { latestAssessment, runAssessment, setRuleVerdict } from './assessment.service';
import { ASSESSMENT_RULES, ASSESSMENT_TABS } from '../../data/assessment-rules';

export const assessmentRouter = Router();
assessmentRouter.use('/:projectId', requireProjectMember);

/** The newest run. Null when nothing has been assessed — the screen says so rather than erroring. */
assessmentRouter.get(
  '/:projectId/assessment',
  asyncHandler(async (req, res) => {
    res.json({
      assessment: await latestAssessment(req.params.projectId),
      tabs: ASSESSMENT_TABS,
      catalogSize: ASSESSMENT_RULES.length,
    });
  }),
);

/**
 * Re-runs the catalog. A write, because it costs model calls and stores a snapshot — a reader
 * pressing it would spend the project's budget and change what everyone else sees.
 */
assessmentRouter.post(
  '/:projectId/assessment/run',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json({ assessment: await runAssessment(req.params.projectId, req.user!.id) });
  }),
);

/** The PM ticks or unticks one rule in the Standards popup. Outranks the model; survives re-runs. */
assessmentRouter.put(
  '/:projectId/assessment/rules/:ruleId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ met: z.boolean() }), req.body);
    res.json({
      assessment: await setRuleVerdict({
        projectId: req.params.projectId,
        ruleId: req.params.ruleId,
        met: body.met,
        actorId: req.user!.id,
      }),
    });
  }),
);
