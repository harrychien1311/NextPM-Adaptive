import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { requireProjectMember } from '../../middleware/auth';
import { ask, history } from './agent.service';

export const agentRouter = Router();
agentRouter.use('/:projectId', requireProjectMember);

agentRouter.get(
  '/:projectId/agent/messages',
  asyncHandler(async (req, res) => {
    res.json({ messages: await history(req.params.projectId) });
  }),
);

agentRouter.post(
  '/:projectId/agent/messages',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ question: z.string().min(1).max(2000) }), req.body);
    res.status(201).json(await ask({ projectId: req.params.projectId, question: body.question }));
  }),
);
