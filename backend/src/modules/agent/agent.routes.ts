import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { requireProjectMember } from '../../middleware/auth';
import {
  ask,
  createSession,
  deleteSession,
  listSessions,
  renameSession,
  sessionMessages,
} from './agent.service';

export const agentRouter = Router();
agentRouter.use('/:projectId', requireProjectMember);

/** The user's chat threads for this project, newest activity first. */
agentRouter.get(
  '/:projectId/agent/sessions',
  asyncHandler(async (req, res) => {
    res.json({ sessions: await listSessions(req.params.projectId, req.user!.id) });
  }),
);

agentRouter.post(
  '/:projectId/agent/sessions',
  asyncHandler(async (req, res) => {
    res.status(201).json(await createSession(req.params.projectId, req.user!.id));
  }),
);

agentRouter.get(
  '/:projectId/agent/sessions/:sessionId/messages',
  asyncHandler(async (req, res) => {
    res.json({
      messages: await sessionMessages(req.params.sessionId, req.params.projectId, req.user!.id),
    });
  }),
);

/** Ask inside one thread — earlier turns of that thread are replayed to the model. */
agentRouter.post(
  '/:projectId/agent/sessions/:sessionId/messages',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ question: z.string().min(1).max(2000) }), req.body);
    res.status(201).json(
      await ask({
        projectId: req.params.projectId,
        sessionId: req.params.sessionId,
        userId: req.user!.id,
        question: body.question,
      }),
    );
  }),
);

agentRouter.patch(
  '/:projectId/agent/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ title: z.string().min(1).max(120) }), req.body);
    res.json(await renameSession(req.params.sessionId, req.params.projectId, req.user!.id, body.title));
  }),
);

agentRouter.delete(
  '/:projectId/agent/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    res.json(await deleteSession(req.params.sessionId, req.params.projectId, req.user!.id));
  }),
);
