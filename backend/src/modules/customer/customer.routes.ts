import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { Role } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { env } from '../../config/env';
import { contentDisposition, decodeUploadFileName } from '../../lib/file-names';
import { requireRole } from '../../middleware/auth';
import {
  addChecklist,
  addTemplate,
  checklistItems,
  createCustomer,
  customerFile,
  deleteChecklist,
  deleteCustomer,
  deleteTemplate,
  listCustomers,
  resolveCustomer,
  setLogo,
  translateChecklist,
  updateCustomer,
} from './customer.service';

fs.mkdirSync(env.uploadDir, { recursive: true });

/** Checklists and templates are Office files; a logo is an image. */
const DOCUMENT_TYPES = ['.xlsx', '.xlsm', '.docx', '.pptx'];
const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.svg', '.webp'];

function uploader(allowed: string[]) {
  return multer({
    storage: multer.diskStorage({
      destination: env.uploadDir,
      filename: (_req, file, cb) => cb(null, `customer-${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
    }),
    limits: { fileSize: env.maxUploadMb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) {
        cb(new Error(`Unsupported file type ${ext} — expected ${allowed.join(', ')}`));
        return;
      }
      cb(null, true);
    },
  });
}

const uploadDocument = uploader(DOCUMENT_TYPES);
const uploadImage = uploader(IMAGE_TYPES);

export const customerRouter = Router();

/**
 * Reading the library is open to every signed-in delivery user — a project owner needs to see
 * which checklist their project will be assessed against. Writing it is not: a checklist is a
 * contract-level artefact, so only a program owner or an administrator may change one.
 */
const requireLibraryWriter = requireRole(Role.PROGRAM_OWNER, Role.ADMIN);

customerRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ customers: await listCustomers() });
  }),
);

/** What the library holds for a typed-in customer name. A suggestion for the PM, never applied. */
customerRouter.get(
  '/resolve',
  asyncHandler(async (req, res) => {
    const query = parse(z.object({ customer: z.string().optional() }), req.query);
    res.json(await resolveCustomer(query.customer));
  }),
);

customerRouter.post(
  '/',
  requireLibraryWriter,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2),
        key: z.string().optional(),
        aliases: z.array(z.string()).optional(),
      }),
      req.body,
    );
    res.status(201).json(await createCustomer({ ...body, actorId: req.user!.id }));
  }),
);

customerRouter.patch(
  '/:customerId',
  requireLibraryWriter,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().min(2).optional(),
        aliases: z.array(z.string()).optional(),
        active: z.boolean().optional(),
      }),
      req.body,
    );
    res.json(await updateCustomer(req.params.customerId, body));
  }),
);

customerRouter.delete(
  '/:customerId',
  requireLibraryWriter,
  asyncHandler(async (req, res) => {
    res.json(await deleteCustomer(req.params.customerId));
  }),
);

customerRouter.post(
  '/:customerId/checklists',
  requireLibraryWriter,
  uploadDocument.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new Error('No file uploaded');
    const fileName = decodeUploadFileName(req.file.originalname);
    res.status(201).json(
      await addChecklist({
        customerId: req.params.customerId,
        name: typeof req.body?.name === 'string' ? req.body.name : fileName,
        fileName,
        mimeType: req.file.mimetype,
        storageKey: req.file.filename,
        actorId: req.user!.id,
      }),
    );
  }),
);

/** The parsed rows, so whoever uploaded the file can check the parse against the original. */
customerRouter.get(
  '/checklists/:checklistId/items',
  asyncHandler(async (req, res) => {
    res.json(await checklistItems(req.params.checklistId));
  }),
);

/**
 * Writes the English reading of every item. An upload does this on its own; this route is for a
 * checklist uploaded before the app held English readings, or one whose translation failed — it
 * saves re-uploading the file to get them. It costs a model call, so it is a deliberate action,
 * never something a page does on being opened.
 */
customerRouter.post(
  '/checklists/:checklistId/translate',
  requireLibraryWriter,
  asyncHandler(async (req, res) => {
    res.json(await translateChecklist(req.params.checklistId));
  }),
);

customerRouter.delete(
  '/checklists/:checklistId',
  requireLibraryWriter,
  asyncHandler(async (req, res) => {
    res.json(await deleteChecklist(req.params.checklistId));
  }),
);

customerRouter.post(
  '/:customerId/templates',
  requireLibraryWriter,
  uploadDocument.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new Error('No file uploaded');
    const fileName = decodeUploadFileName(req.file.originalname);
    res.status(201).json(
      await addTemplate({
        customerId: req.params.customerId,
        documentType: typeof req.body?.documentType === 'string' ? req.body.documentType : '',
        fileName,
        mimeType: req.file.mimetype,
        storageKey: req.file.filename,
        actorId: req.user!.id,
      }),
    );
  }),
);

customerRouter.delete(
  '/templates/:templateId',
  requireLibraryWriter,
  asyncHandler(async (req, res) => {
    res.json(await deleteTemplate(req.params.templateId));
  }),
);

customerRouter.post(
  '/:customerId/logo',
  requireLibraryWriter,
  uploadImage.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new Error('No file uploaded');
    res.json(
      await setLogo({
        customerId: req.params.customerId,
        fileName: decodeUploadFileName(req.file.originalname),
        mimeType: req.file.mimetype,
        storageKey: req.file.filename,
      }),
    );
  }),
);

/** Serves the stored original — the uploader checks the parse against the real file. */
const FILE_KINDS = { checklists: 'checklist', templates: 'template', logo: 'logo' } as const;

customerRouter.get(
  '/:kind(checklists|templates|logo)/:id/file',
  asyncHandler(async (req, res) => {
    const kind = FILE_KINDS[req.params.kind as keyof typeof FILE_KINDS];
    const file = await customerFile(kind, req.params.id);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(kind === 'logo' ? 'inline' : 'attachment', file.fileName));
    res.sendFile(path.resolve(file.path));
  }),
);
