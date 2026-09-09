import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { env } from '../../config/env';
import { PM_ROLES, requireRole } from '../../middleware/auth';
import {
  addCustomField,
  inputProfile,
  registerDescriptionDocument,
  registerReference,
  removeCustomField,
  removeReference,
  resolveAction,
  saveValues,
  verifyInputs,
} from './input.service';

/** The four classified groups; DESCRIPTION has its own upload endpoint below. */
const CLASSIFIED_GROUPS = ['COMMITMENT', 'SCOPE', 'ORGANIZATION', 'SCHEDULE'] as const;

fs.mkdirSync(env.uploadDir, { recursive: true });

const ALLOWED = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt'];

const upload = multer({
  storage: multer.diskStorage({
    destination: env.uploadDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.includes(ext)) {
      cb(new Error(`Unsupported file type ${ext}`));
      return;
    }
    cb(null, true);
  },
});

export const inputRouter = Router();

inputRouter.get(
  '/:projectId/input',
  asyncHandler(async (req, res) => {
    res.json(await inputProfile(req.params.projectId));
  }),
);

inputRouter.put(
  '/:projectId/input',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        values: z.array(z.object({ definitionId: z.string().uuid(), value: z.string().nullable() })).min(1),
      }),
      req.body,
    );
    res.json(await saveValues({ projectId: req.params.projectId, actorId: req.user!.id, values: body.values }));
  }),
);

inputRouter.post(
  '/:projectId/input/verify',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await verifyInputs(req.params.projectId, req.user!.id));
  }),
);

inputRouter.post(
  '/:projectId/custom-fields',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(1),
        value: z.string().optional(),
        useIn: z.enum(['RULES', 'DOCUMENT', 'BOTH']).optional(),
      }),
      req.body,
    );
    res.status(201).json(await addCustomField({ projectId: req.params.projectId, ...body }));
  }),
);

inputRouter.delete(
  '/:projectId/custom-fields/:id',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await removeCustomField(req.params.projectId, req.params.id));
  }),
);

inputRouter.post(
  '/:projectId/actions/:actionId/resolve',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ value: z.string().min(1) }), req.body);
    res.json(
      await resolveAction({
        projectId: req.params.projectId,
        actionId: req.params.actionId,
        value: body.value,
        actorId: req.user!.id,
      }),
    );
  }),
);

inputRouter.post(
  '/:projectId/references',
  requireRole(...PM_ROLES),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ group: z.enum(CLASSIFIED_GROUPS) }), req.body);
    if (!req.file) return res.status(400).json({ error: { message: 'A file is required' } });
    res.status(201).json(
      await registerReference({
        projectId: req.params.projectId,
        group: body.group,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storageKey: req.file.filename,
        actorId: req.user!.id,
      }),
    );
  }),
);

inputRouter.delete(
  '/:projectId/references/:id',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await removeReference(req.params.projectId, req.params.id));
  }),
);

/** The project description document — a single free-form file read for the AI advisory suggestion. */
inputRouter.post(
  '/:projectId/description',
  requireRole(...PM_ROLES),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: { message: 'A file is required' } });
    res.status(201).json(
      await registerDescriptionDocument({
        projectId: req.params.projectId,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storageKey: req.file.filename,
        actorId: req.user!.id,
      }),
    );
  }),
);
