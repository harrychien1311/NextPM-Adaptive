import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { authenticate } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './modules/auth/auth.routes';
import { portfolioRouter, projectRouter } from './modules/portfolio/portfolio.routes';
import { inputRouter } from './modules/input/input.routes';
import { rulesRouter } from './modules/rules/rules.routes';
import { documentsRouter } from './modules/documents/documents.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { agentRouter } from './modules/agent/agent.routes';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  if (!env.isProd) app.use(morgan('dev'));

  app.get('/health', (_req, res) => res.json({ status: 'ok', env: env.nodeEnv, time: new Date().toISOString() }));

  app.use('/api/auth', rateLimit({ windowMs: 60_000, limit: 20 }), authRouter);

  // Everything below requires a signed-in user.
  const api = express.Router();
  api.use(authenticate);
  api.use('/portfolios', portfolioRouter);
  api.use('/projects', projectRouter);
  api.use('/projects', inputRouter);
  api.use('/projects', rulesRouter);
  api.use('/projects', documentsRouter);
  api.use('/projects', dashboardRouter);
  api.use('/projects', agentRouter);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
