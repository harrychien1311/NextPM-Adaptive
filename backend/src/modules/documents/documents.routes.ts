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
  discardDocument,
  documentDetail,
  documentSheets,
  documentSlides,
  domainSummary,
  fillDocumentGaps,
  generateDocumentForDefinition,
  renderApprovedBaseline,
  renderDashboardHtml,
  renderDocumentDocx,
  renderDocumentExport,
  renderDocumentXlsx,
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
        actorId: req.user!.id,
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

/**
 * Throws away a generated draft, putting the catalog entry back to "not generated". Write role
 * only — a reader may download a document but never remove one.
 */
documentsRouter.delete(
  '/:projectId/documents/:documentId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(
      await discardDocument({
        projectId: req.params.projectId,
        documentId: req.params.documentId,
        actorId: req.user!.id,
      }),
    );
  }),
);

/**
 * The slides of the deck this document downloads as, read out of the real rendered file — what
 * the on-screen preview draws. No model call; it renders the export and reads it back.
 */
documentsRouter.get(
  '/:projectId/documents/:documentId/slides',
  asyncHandler(async (req, res) => {
    res.json(await documentSlides(req.params.projectId, req.params.documentId));
  }),
);

/** The same, for a document filled from a customer's workbook: the real sheets of the real file. */
documentsRouter.get(
  '/:projectId/documents/:documentId/sheets',
  asyncHandler(async (req, res) => {
    res.json(await documentSheets(req.params.projectId, req.params.documentId));
  }),
);

/**
 * Real Office download for one planning document — rendered on demand, nothing persisted.
 * The server picks the container: RACI documents come back as `.xlsx`, everything else `.docx`,
 * so the client never has to guess. The real name and type ride on the response headers.
 */
documentsRouter.get(
  '/:projectId/documents/:documentId/export',
  asyncHandler(async (req, res) => {
    const { fileName, buffer, contentType } = await renderDocumentExport(
      req.params.projectId,
      req.params.documentId,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.send(buffer);
  }),
);

/** Kept so links saved before the format-aware route above still resolve. */
documentsRouter.get(
  '/:projectId/documents/:documentId/export.docx',
  asyncHandler(async (req, res) => {
    const { fileName, buffer } = await renderDocumentDocx(req.params.projectId, req.params.documentId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.send(buffer);
  }),
);

/** Direct spreadsheet download, for a caller that wants the matrix regardless of the default. */
documentsRouter.get(
  '/:projectId/documents/:documentId/export.xlsx',
  asyncHandler(async (req, res) => {
    const { fileName, buffer } = await renderDocumentXlsx(req.params.projectId, req.params.documentId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
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

/**
 * The approved baseline as one downloadable `.zip`. A POST because it is not only a read — it
 * records an `ExportJob` and a `BASELINE_EXPORTED` audit event, which is how "what was promised,
 * and when" stays answerable after the files have left the application.
 */
documentsRouter.post(
  '/:projectId/exports',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const { fileName, buffer, contentType, packed } = await renderApprovedBaseline({
      projectId: req.params.projectId,
      format: 'ZIP',
      actorId: req.user!.id,
    });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    res.setHeader('X-Document-Count', String(packed));
    res.send(buffer);
  }),
);
