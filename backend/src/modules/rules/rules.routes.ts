import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'node:path';
import { DecisionOutcome } from '@prisma/client';
import { asyncHandler } from '../../lib/async-handler';
import { env } from '../../config/env';
import { badRequest } from '../../lib/http-error';
import { decodeUploadFileName } from '../../lib/file-names';
import { parse } from '../../lib/validate';
import { PROJECT_WRITE_ROLES, requireProjectMember, requireProjectRole } from '../../middleware/auth';
import {
  activeDecision,
  approachOptions,
  decideApproach,
  latestEvaluation,
  runEvaluation,
  runPlanningAnalysis,
} from './rules.service';
import {
  addUploadedPlanChangeDocument,
  applyPlanChange,
  MAX_CHANGE_UPLOAD_MB,
  currentPlanChange,
  dismissPlanChange,
  planChangeHistory,
  runPlanChangeAnalysis,
  setPlanChangeDocumentReplaces,
  startPlanChange,
  suggestPlanChangeDocuments,
  updatePlanChange,
} from './plan-change.service';

/**
 * Uploads made from the change panel. Its own multer instance rather than the input module's,
 * because the limits are the change's own: ten documents of ten megabytes, in any format the text
 * extractor is asked to read. The legacy binaries (.doc, .xls, .ppt) are accepted and stored, but
 * nothing can be read out of them — the row says so rather than the upload being refused, since the
 * PM may still want the file attached to the record of the change.
 */
const CHANGE_UPLOAD_TYPES = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt'];

const changeUpload = multer({
  storage: multer.diskStorage({
    destination: env.uploadDir,
    filename: (_req, file, cb) => cb(null, `change-${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
  }),
  limits: { fileSize: MAX_CHANGE_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!CHANGE_UPLOAD_TYPES.includes(extension)) {
      // An HttpError, not a plain one: the error handler sanitises anything else to "Unexpected
      // server error" in production, which tells the PM nothing about a file they chose themselves.
      return cb(badRequest(`Unsupported file type ${extension} — allowed: ${CHANGE_UPLOAD_TYPES.join(', ')}`));
    }
    return cb(null, true);
  },
});

export const rulesRouter = Router();
rulesRouter.use('/:projectId', requireProjectMember);

/** Read the current recommendation, scored alternatives and PM decision state. */
rulesRouter.get(
  '/:projectId/approach',
  asyncHandler(async (req, res) => {
    const [evaluation, options, decision] = await Promise.all([
      latestEvaluation(req.params.projectId),
      approachOptions(req.params.projectId),
      activeDecision(req.params.projectId),
    ]);
    res.json({ evaluation, options, decision });
  }),
);

/** Asks the AI (Skill 1) to recommend a governance model from verified inputs + the project description document. */
rulesRouter.post(
  '/:projectId/approach/evaluate',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await runEvaluation(req.params.projectId, req.user!.id));
  }),
);

/**
 * "Analyze planning needs" — the single call behind the Planning Review screen. Reads every
 * uploaded document and what the PM typed, and returns the overview, the approach advisory, the
 * planning gaps and the document findings in one snapshot.
 */
rulesRouter.post(
  '/:projectId/planning/analyze',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.status(201).json(await runPlanningAnalysis(req.params.projectId, req.user!.id));
  }),
);

// ------------------------------------------------------------------ Change plan mode
//
// A change to a plan that already exists. Reading is open to every project member; every write is
// an owner's, like the rest of the planning flow.

/** The change currently open, if any — this is what puts Project Input and Planning Review into change mode. */
rulesRouter.get(
  '/:projectId/plan-changes/current',
  asyncHandler(async (req, res) => {
    const change = await currentPlanChange(req.params.projectId);
    // Reading it proposes whatever has been uploaded since the last analysis, so the panel shows the
    // change as it stands rather than as it was when the PM last touched it. Writers only: a reader
    // opening the screen must not alter what the change contains.
    if (change && req.projectRole === 'OWNER') {
      await suggestPlanChangeDocuments(req.params.projectId, change.id);
      return res.json({ change: await currentPlanChange(req.params.projectId) });
    }
    return res.json({ change });
  }),
);

/** Every change ever recorded, newest first — the Plan history screen. */
rulesRouter.get(
  '/:projectId/plan-changes',
  asyncHandler(async (req, res) => {
    res.json({ changes: await planChangeHistory(req.params.projectId) });
  }),
);

/** Opens change mode, or hands back the change already open. */
rulesRouter.post(
  '/:projectId/plan-changes',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.status(201).json(await startPlanChange(req.params.projectId, req.user!.id));
  }),
);

rulesRouter.patch(
  '/:projectId/plan-changes/:changeId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ note: z.string().max(4000).nullable().optional() }), req.body);
    res.json(await updatePlanChange({ projectId: req.params.projectId, changeId: req.params.changeId, ...body }));
  }),
);

/**
 * The documents that make up the change. Proposed from what has been uploaded since the last
 * analysis; the PM adds a file that predates it, or removes one that does not belong.
 */
rulesRouter.post(
  '/:projectId/plan-changes/:changeId/documents/suggest',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json({ documents: await suggestPlanChangeDocuments(req.params.projectId, req.params.changeId) });
  }),
);

// There is deliberately no "attach an existing upload" or "unlink without deleting" route any more.
// The change panel's ✕ deletes the file (`DELETE /:projectId/references/:id`), so there is nothing
// to re-attach, and a second meaning for ✕ on one screen is exactly the confusion to avoid.

/**
 * Uploading straight into the change. While a change is open this is the only upload box on the
 * screen — the project's own two panels are hidden, because "what is this project" and "what has
 * changed about it" are different questions and answering the first while recording the second is
 * how documents end up attached to neither.
 */
rulesRouter.post(
  '/:projectId/plan-changes/:changeId/documents/upload',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  changeUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: { message: 'A file is required' } });
    return res.status(201).json(
      await addUploadedPlanChangeDocument({
        projectId: req.params.projectId,
        changeId: req.params.changeId,
        fileName: decodeUploadFileName(req.file.originalname),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storageKey: req.file.filename,
      }),
    );
  }),
);

/**
 * "This is a new version of X" — or is not. The upload slot only proposes it; nothing but the PM
 * can tell a revised document from a new one reliably.
 */
rulesRouter.patch(
  '/:projectId/plan-changes/:changeId/documents/:referenceId',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ supersedesReferenceId: z.string().nullable() }), req.body);
    res.json({
      documents: await setPlanChangeDocumentReplaces({
        projectId: req.params.projectId,
        changeId: req.params.changeId,
        referenceId: req.params.referenceId,
        supersedesReferenceId: body.supersedesReferenceId,
      }),
    });
  }),
);

/** Skill 1c — the delta call. Produces the impact for review; changes nothing about the plan. */
rulesRouter.post(
  '/:projectId/plan-changes/:changeId/analyze',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await runPlanChangeAnalysis(req.params.projectId, req.params.changeId, req.user!.id));
  }),
);

/** The PM gate: merge the delta into a new snapshot and move the plan. */
rulesRouter.post(
  '/:projectId/plan-changes/:changeId/apply',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await applyPlanChange(req.params.projectId, req.params.changeId, req.user!.id));
  }),
);

rulesRouter.post(
  '/:projectId/plan-changes/:changeId/dismiss',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    res.json(await dismissPlanChange(req.params.projectId, req.params.changeId, req.user!.id));
  }),
);

/** The PM decision gate: confirm the recommendation, or override with a reason. */
rulesRouter.post(
  '/:projectId/approach/decide',
  requireProjectRole(...PROJECT_WRITE_ROLES),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        approach: z.string().min(1),
        outcome: z.nativeEnum(DecisionOutcome).optional(),
        rationale: z.string().max(2000).optional(),
      }),
      req.body,
    );
    res.status(201).json(
      await decideApproach({
        projectId: req.params.projectId,
        approach: body.approach,
        outcome: body.outcome ?? DecisionOutcome.CONFIRMED,
        rationale: body.rationale,
        decidedById: req.user!.id,
      }),
    );
  }),
);
