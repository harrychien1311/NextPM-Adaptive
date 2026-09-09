import { Router } from 'express';
import { z } from 'zod';
import { ManagementDomain } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { PM_ROLES, requireRole } from '../../middleware/auth';
import {
  approveDocument,
  catalogForProject,
  createExport,
  documentDetail,
  domainSummary,
  generateDraft,
  renderDashboardHtml,
  renderDocumentDocx,
  setGenerationContract,
  templateFit,
} from './documents.service';

export const documentsRouter = Router();

documentsRouter.get(
  '/:projectId/documents',
  asyncHandler(async (req, res) => {
    const query = parse(z.object({ domain: z.nativeEnum(ManagementDomain).optional() }), req.query);
    const [catalog, domains] = await Promise.all([
      catalogForProject(req.params.projectId, query.domain),
      domainSummary(req.params.projectId),
    ]);
    res.json({ catalog, domains });
  }),
);

documentsRouter.get(
  '/:projectId/documents/:documentId',
  asyncHandler(async (req, res) => {
    res.json(await documentDetail(req.params.projectId, req.params.documentId));
  }),
);

documentsRouter.get(
  '/:projectId/documents/:definitionId/fit',
  asyncHandler(async (req, res) => {
    res.json(await templateFit(req.params.projectId, req.params.definitionId));
  }),
);

/** Choose a template and edit the section structure — the generation contract. */
documentsRouter.post(
  '/:projectId/documents/contract',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        definitionId: z.string().uuid(),
        templateId: z.string().uuid(),
        sections: z
          .array(
            z.object({
              title: z.string().min(1),
              hint: z.string().optional(),
              required: z.boolean().optional(),
              included: z.boolean().optional(),
              custom: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
      req.body,
    );
    res.json(await setGenerationContract({ projectId: req.params.projectId, ...body }));
  }),
);

documentsRouter.post(
  '/:projectId/documents/:documentId/generate',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    res.json(
      await generateDraft({
        projectId: req.params.projectId,
        documentId: req.params.documentId,
        actorId: req.user!.id,
      }),
    );
  }),
);

documentsRouter.post(
  '/:projectId/documents/:documentId/approve',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    res.json(
      await approveDocument({
        projectId: req.params.projectId,
        documentId: req.params.documentId,
        actorId: req.user!.id,
      }),
    );
  }),
);

/** Real .docx download for one planning document — rendered on demand, nothing persisted. */
documentsRouter.get(
  '/:projectId/documents/:documentId/export.docx',
  asyncHandler(async (req, res) => {
    const { fileName, buffer } = await renderDocumentDocx(req.params.projectId, req.params.documentId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }),
);

/** The project overview dashboard as a real, self-contained .html file. */
documentsRouter.get(
  '/:projectId/dashboard/export.html',
  asyncHandler(async (req, res) => {
    const html = await renderDashboardHtml(req.params.projectId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="dashboard.html"`);
    res.send(html);
  }),
);

documentsRouter.post(
  '/:projectId/exports',
  requireRole(...PM_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ format: z.enum(['DOCX', 'XLSX', 'PDF', 'CONFLUENCE']) }), req.body);
    res.status(201).json(await createExport({ projectId: req.params.projectId, format: body.format, actorId: req.user!.id }));
  }),
);
