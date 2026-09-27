import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { PROJECT_WRITE_ROLES, requireProjectMember, requireProjectRole } from '../../middleware/auth';
import { serviceUnavailable } from '../../lib/http-error';
import { latestAssessment, runFullAssessment, setRuleVerdict } from './assessment.service';
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
 * Re-assess: the FPT standard, then the customer's checklist. A write, because it costs model calls
 * and stores a snapshot — a reader pressing it would spend the project's budget and change what
 * everyone else sees. An FPT failure is still an error response (the screen has nothing new to show);
 * the customer step's outcome rides along either way.
 */
assessmentRouter.post(
  '/:projectId/assessment/run',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const result = await runFullAssessment(req.params.projectId, req.user!.id);
    if (!result.assessment) throw serviceUnavailable(result.fptError ?? 'The FPT standard assessment failed.');
    res.json({ assessment: result.assessment, customerStandard: result.customerStandard });
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
