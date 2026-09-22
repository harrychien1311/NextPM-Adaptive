import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { env } from '../../config/env';
import { contentDisposition, decodeUploadFileName } from '../../lib/file-names';
import { PROJECT_WRITE_ROLES, requireProjectMember, requireProjectRole } from '../../middleware/auth';
import {
  addCustomField,
  inputProfile,
  referenceDetail,
  referenceFilePath,
  registerDescriptionDocument,
  registerReference,
  removeCustomField,
  removeReference,
  resolveAction,
  resolveCustomerSuggestion,
  saveValues,
  verifyInputs,
} from './input.service';

/** Every group with its own upload tile; DESCRIPTION has a separate endpoint below. */
const CLASSIFIED_GROUPS = ['COMMITMENT', 'SCOPE', 'ORGANIZATION', 'SCHEDULE', 'OTHER'] as const;

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

/** Every route below is scoped to :projectId — isolate per project membership first. */
inputRouter.use('/:projectId', requireProjectMember);

inputRouter.get(
  '/:projectId/input',
  asyncHandler(async (req, res) => {
    res.json(await inputProfile(req.params.projectId));
  }),
);

inputRouter.put(
  '/:projectId/input',
  requireProjectRole(...PROJECT_WRITE_ROLES),
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
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await verifyInputs(req.params.projectId, req.user!.id));
  }),
);

/**
 * The PM's decision on the customer Skill 0 proposed. Deliberately a distinct, explicit step —
 * extraction may only ever propose a customer, because the wrong one means the project is scored
 * against the wrong checklist and another company's template gets filled with it.
 */
inputRouter.post(
  '/:projectId/input/customer-suggestion',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        action: z.enum(['accept', 'dismiss']),
        /** The PM may correct the proposed name before accepting it. */
        value: z.string().min(1).max(200).optional(),
      }),
      req.body,
    );
    res.json(
      await resolveCustomerSuggestion({
        projectId: req.params.projectId,
        action: body.action,
        value: body.value ?? null,
        actorId: req.user!.id,
      }),
    );
  }),
);

inputRouter.post(
  '/:projectId/custom-fields',
  requireProjectRole(...PROJECT_WRITE_ROLES),
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
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await removeCustomField(req.params.projectId, req.params.id));
  }),
);

inputRouter.post(
  '/:projectId/actions/:actionId/resolve',
  requireProjectRole(...PROJECT_WRITE_ROLES),
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
  requireProjectRole(...PROJECT_WRITE_ROLES),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ group: z.enum(CLASSIFIED_GROUPS) }), req.body);
    if (!req.file) return res.status(400).json({ error: { message: 'A file is required' } });
    res.status(201).json(
      await registerReference({
        projectId: req.params.projectId,
        group: body.group,
        fileName: decodeUploadFileName(req.file.originalname),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storageKey: req.file.filename,
        actorId: req.user!.id,
      }),
    );
  }),
);

/** Metadata + extracted text, for the preview panel. Any project member may read it. */
inputRouter.get(
  '/:projectId/references/:id',
  asyncHandler(async (req, res) => {
    res.json(await referenceDetail(req.params.projectId, req.params.id));
  }),
);

/** The original file as uploaded — `inline` so a PDF opens in the browser's own viewer. */
inputRouter.get(
  '/:projectId/references/:id/file',
  asyncHandler(async (req, res) => {
    const { path: filePath, fileName, mimeType } = await referenceFilePath(req.params.projectId, req.params.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: { message: 'The stored file is no longer on disk' } });
    }
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition('inline', fileName));
    return res.sendFile(path.resolve(filePath));
  }),
);

inputRouter.delete(
  '/:projectId/references/:id',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await removeReference(req.params.projectId, req.params.id, req.user!.id));
  }),
);

/** The project description document — a single free-form file read for the AI advisory suggestion. */
inputRouter.post(
  '/:projectId/description',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: { message: 'A file is required' } });
    res.status(201).json(
      await registerDescriptionDocument({
        projectId: req.params.projectId,
        fileName: decodeUploadFileName(req.file.originalname),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storageKey: req.file.filename,
        actorId: req.user!.id,
      }),
    );
  }),
);
