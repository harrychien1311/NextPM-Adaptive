import { Router } from 'express';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { requireRole } from '../../middleware/auth';
import { createAccount, deleteAccount, listAccounts, resetPassword, updateAccount } from './admin.service';

export const adminRouter = Router();

// The whole console is administrator-only — no delivery route lives here.
adminRouter.use(requireRole(Role.ADMIN));

adminRouter.get(
  '/users',
  asyncHandler(async (_req, res) => {
    res.json(await listAccounts());
  }),
);

adminRouter.post(
  '/users',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        email: z.string().email(),
        name: z.string().min(2),
        password: z.string().min(8, 'Use at least 8 characters'),
        jobTitle: z.string().optional(),
        role: z.nativeEnum(Role),
      }),
      req.body,
    );
    res.status(201).json(await createAccount(body));
  }),
);

adminRouter.patch(
  '/users/:userId',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2).optional(),
        jobTitle: z.string().optional(),
        role: z.nativeEnum(Role).optional(),
        active: z.boolean().optional(),
      }),
      req.body,
    );
    res.json(await updateAccount(req.user!.id, req.params.userId, body));
  }),
);

adminRouter.post(
  '/users/:userId/password',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ password: z.string().min(8, 'Use at least 8 characters') }), req.body);
    res.json(await resetPassword(req.params.userId, body.password));
  }),
);

adminRouter.delete(
  '/users/:userId',
  asyncHandler(async (req, res) => {
    res.json(await deleteAccount(req.user!.id, req.params.userId));
  }),
);
