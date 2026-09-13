import { Router } from 'express';
import { z } from 'zod';
import { ManagementDomain } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { parse } from '../../lib/validate';
import { contentDisposition } from '../../lib/file-names';
import { PROJECT_WRITE_ROLES, requireProjectMember, requireProjectRole } from '../../middleware/auth';
import {
  answerDocumentGap,
  approveDocument,
  catalogForProject,
  createExport,
  documentDetail,
  domainSummary,
  fillDocumentGaps,
  generateDocumentForDefinition,
  renderDashboardHtml,
  renderDocumentDocx,
  templateFit,
  updateDocumentSections,
} from './documents.service';

export const documentsRouter = Router();
documentsRouter.use('/:projectId', requireProjectMember);

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

/**
 * Generate one catalog document. There is no template or section contract to set first — the
 * model decides the structure and reports what it could not source as gaps.
 */
documentsRouter.post(
  '/:projectId/documents/generate',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ definitionId: z.string().uuid() }), req.body);
    res.json(
      await generateDocumentForDefinition({
        projectId: req.params.projectId,
        definitionId: body.definitionId,
        actorId: req.user!.id,
      }),
    );
  }),
);

/** "Edit content" — the PM rewrites the draft in place. */
documentsRouter.put(
  '/:projectId/documents/:documentId/sections',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        sections: z.array(z.object({ title: z.string().min(1), content: z.string() })).min(1),
      }),
      req.body,
    );
    res.json(
      await updateDocumentSections({
        projectId: req.params.projectId,
        documentId: req.params.documentId,
        sections: body.sections,
        actorId: req.user!.id,
      }),
    );
  }),
);

/** Answer one "PM confirmation needed" question. Recorded only — nothing is written yet. */
documentsRouter.post(
  '/:projectId/documents/:documentId/gaps',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ token: z.string().min(1), answer: z.string().min(1) }), req.body);
    res.json(
      await answerDocumentGap({
        projectId: req.params.projectId,
        documentId: req.params.documentId,
        ...body,
      }),
    );
  }),
);

/** "Fill out the document" — writes every answered gap into the blanks it belongs to. */
documentsRouter.post(
  '/:projectId/documents/:documentId/fill',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(
      await fillDocumentGaps({
        projectId: req.params.projectId,
        documentId: req.params.documentId,
        actorId: req.user!.id,
      }),
    );
  }),
);

documentsRouter.post(
  '/:projectId/documents/:documentId/approve',
  requireProjectRole(...PROJECT_WRITE_ROLES),
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
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.send(buffer);
  }),
);

/** The project overview dashboard as a real, self-contained .html file. */
documentsRouter.get(
  '/:projectId/dashboard/export.html',
  asyncHandler(async (req, res) => {
    const html = await renderDashboardHtml(req.params.projectId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', contentDisposition('attachment', 'dashboard.html'));
    res.send(html);
  }),
);

documentsRouter.post(
  '/:projectId/exports',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ format: z.enum(['DOCX', 'XLSX', 'PDF', 'CONFLUENCE']) }), req.body);
    res.status(201).json(await createExport({ projectId: req.params.projectId, format: body.format, actorId: req.user!.id }));
  }),
);
