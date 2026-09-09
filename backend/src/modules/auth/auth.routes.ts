import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { authenticate } from '../../middleware/auth';
import { prisma } from '../../lib/prisma';
import { login, publicUser, register } from './auth.service';

export const authRouter = Router();

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(6) }), req.body);
    res.json(await login(body.email, body.password));
  }),
);

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        email: z.string().email(),
        name: z.string().min(2),
        password: z.string().min(8, 'Use at least 8 characters'),
        jobTitle: z.string().optional(),
      }),
      req.body,
    );
    res.status(201).json(await register(body));
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    res.json({ user: publicUser(user) });
  }),
);
