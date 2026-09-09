import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { listEvents } from '../audit/audit.service';
import { dashboard, saveLayout } from './dashboard.service';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/:projectId/dashboard',
  asyncHandler(async (req, res) => {
    res.json(await dashboard(req.params.projectId, req.user!.id));
  }),
);

dashboardRouter.put(
  '/:projectId/dashboard/layout',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ widgets: z.record(z.boolean()) }), req.body);
    res.json(await saveLayout(req.params.projectId, req.user!.id, body.widgets));
  }),
);

dashboardRouter.get(
  '/:projectId/activity',
  asyncHandler(async (req, res) => {
    res.json({ events: await listEvents(req.params.projectId, Number(req.query.limit ?? 30)) });
  }),
);
