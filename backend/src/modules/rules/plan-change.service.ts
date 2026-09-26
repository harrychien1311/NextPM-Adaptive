import { PlanChangeStatus, Prisma, ReferenceStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/http-error';
import { extractTextFromFile } from '../../lib/extract-text';
import { mergeSnapshot } from '../../lib/merge-snapshot';
import {
  analyzePlanChange,
  normalizeEvidence,
  type AnalysisFinding,
  type OverviewSection,
  type PlanChangeImpact,
  type PlanningGap,
  type ScoredApproach,
} from '../ai/provider';
import { logEvent } from '../audit/audit.service';
import { syncPlanningActions } from '../input/input.service';
import { applyAssessmentUpdates, assessmentRulesForChange } from '../assessment/assessment.service';

/**
 * Change plan mode — recording a change to a plan that already exists.
 *
 * The shape of the whole feature comes from one decision: **the model returns only a delta and this
 * module merges it**. A full re-analysis writes roughly eleven thousand output tokens, the great
 * majority restating what did not change, and output costs about five times what input does. Asking
 * only "what moved" is the one optimisation here that reaches the actual bill — and it means every
 * screen downstream keeps receiving an ordinary `AiApproachSuggestion` and none of them has to know
 * this mode exists.
 *
 * Re-reading the documents is not worth avoiding, incidentally: a whole project's corpus measures a
 * few thousand tokens against a million-token window, and text is extracted once at upload and read
 * back from Postgres. There is nothing here for a retrieval index to retrieve from.
 */

/** How much of each document the change analysis reads. Same ceiling as the full analysis. */
const DOCUMENT_CHARS = 18_000;

function documentText(file: { fileName: string; extraction: Prisma.JsonValue } | null) {
  if (!file) return null;
  const extraction = file.extraction as { rawText?: string; textAvailable?: boolean } | null;
  if (!extraction?.textAvailable || !extraction.rawText) return null;
  return { label: file.fileName, text: extraction.rawText.slice(0, DOCUMENT_CHARS) };
}

/**
 * The change the PM is currently working on, if any.
 *
 * At most one may be open. Two changes analysed in parallel would each be merged onto the same
 * snapshot and the second would silently overwrite the first's reading of the project — with nobody
 * able to say afterwards which one the plan reflects.
 */
export async function currentPlanChange(projectId: string) {
  return prisma.planChange.findFirst({
    where: { projectId, status: { in: [PlanChangeStatus.DRAFT, PlanChangeStatus.ANALYZED] } },
    orderBy: { createdAt: 'desc' },
    include: { documents: { orderBy: { createdAt: 'asc' } } },
  });
}

/**
 * Proposes the documents that belong to this change: everything uploaded since the analysis it is
 * measured against.
 *
 * Auto-populated and then editable, because neither half works alone. Sweeping in every upload
 * without asking catches files that have nothing to do with the change; making the PM add each one
 * by hand means the second and third documents of a three-document change are quietly forgotten,
 * which is exactly what the single-pair version did.
 *
 * Only ever *adds*, and only files that still exist. `PlanChange.removedReferenceIds` is read here
 * but nothing writes it any more: ✕ deletes the upload outright rather than unlinking it, so a
 * document taken out of a change is gone and can never be proposed again. The column is left in
 * place rather than migrated away, the way `PROJECT_PLAN` and `PlanningTask` were.
 */
export async function suggestPlanChangeDocuments(projectId: string, changeId: string) {
  const [change, previous] = await Promise.all([
    prisma.planChange.findFirst({ where: { id: changeId, projectId }, include: { documents: true } }),
    prisma.aiApproachSuggestion.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } }),
  ]);
  if (!change) throw notFound('Plan change not found');
  if (change.status === PlanChangeStatus.APPLIED || change.status === PlanChangeStatus.DISMISSED) return [];

  const since = previous?.createdAt ?? change.createdAt;
  const candidates = await prisma.referenceFile.findMany({
    // Current files only: a superseded one is the "before" half of a pair, never the change itself.
    where: { projectId, supersededAt: null, uploadedAt: { gt: since } },
    orderBy: { uploadedAt: 'asc' },
  });

  const alreadyListed = new Set(change.documents.map((document) => document.referenceId));
  const removed = new Set((change.removedReferenceIds as string[] | null) ?? []);
  const toAdd = candidates.filter((file) => !alreadyListed.has(file.id) && !removed.has(file.id));
  if (!toAdd.length) return change.documents;

  // The version each one replaced, when it replaced one — an exact lookup, not a guess from times.
  const replaced = await prisma.referenceFile.findMany({
    where: { supersededById: { in: toAdd.map((file) => file.id) } },
    select: { id: true, supersededById: true },
  });
  const replacedBy = new Map(replaced.map((file) => [file.supersededById!, file.id]));

  await prisma.planChangeDocument.createMany({
    data: toAdd.map((file) => ({
      changeId,
      referenceId: file.id,
      supersedesReferenceId: replacedBy.get(file.id) ?? null,
    })),
    skipDuplicates: true,
  });

  return prisma.planChangeDocument.findMany({ where: { changeId }, orderBy: { createdAt: 'asc' } });
}

/** How many documents one change may carry, and how big each may be. */
export const MAX_CHANGE_DOCUMENTS = 10;
export const MAX_CHANGE_UPLOAD_MB = 10;

/**
 * Reduces a file name to what it is *about*, so two versions of the same document collapse to the
 * same stem: "SOW_v2 (final).pdf" and "SOW v1.pdf" both become "sow".
 *
 * Deliberately conservative — equal stems only, no fuzzy distance. A near-miss that guessed wrong
 * would pair two unrelated documents and have the analysis report the difference between them as a
 * change to the project, which is a much more expensive mistake than proposing nothing. It is a
 * proposal in any case: the row carries a select and the PM sees what was assumed.
 */
export function documentStem(fileName: string) {
  return (
    fileName
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      /**
       * Separators become spaces *first*, and this line is the whole trick. `_` is a word character
       * in a regular expression, so there is no `\b` between it and what follows — "SOW_v2" left the
       * version marker intact and stemmed to "sowv2", which matched nothing. Underscores are one of
       * the two commonest ways people version a file name, so the matcher silently did nothing on
       * half its cases.
       */
      .replace(/[_\-.()[\]]+/g, ' ')
      .replace(/\b\d{4}\s?\d{2}\s?\d{2}\b/g, ' ')
      .replace(/\b(v|ver|version|rev|r)\s*\d+(\s*\d+)*\b/g, ' ')
      .replace(/\b(final|draft|updated|update|new|old|copy|latest)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, '')
  );
}

/**
 * Stores a document uploaded from the change panel and adds it to the change.
 *
 * Change mode hides the project's ordinary upload boxes, so this is the only way in while it is
 * open — which is the point: the documents list stops being a read-only summary of uploads made
 * elsewhere and becomes the place the PM actually works.
 */
export async function addUploadedPlanChangeDocument(params: {
  projectId: string;
  changeId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
}) {
  const change = await prisma.planChange.findFirst({
    where: { id: params.changeId, projectId: params.projectId },
    include: { documents: true },
  });
  if (!change) throw notFound('Plan change not found');
  if (change.status === PlanChangeStatus.APPLIED || change.status === PlanChangeStatus.DISMISSED) {
    throw conflict('This change has already been applied or dismissed');
  }
  if (change.documents.length >= MAX_CHANGE_DOCUMENTS) {
    throw badRequest(
      `A change can carry ${MAX_CHANGE_DOCUMENTS} documents — remove one before adding another.`,
    );
  }

  const { text, unsupportedFormat } = await extractTextFromFile({
    storageKey: params.storageKey,
    fileName: params.fileName,
  });

  const file = await prisma.referenceFile.create({
    data: {
      projectId: params.projectId,
      group: 'CHANGE',
      fileName: params.fileName,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      storageKey: params.storageKey,
      status: text ? ReferenceStatus.UPLOADED : ReferenceStatus.WARNING,
      message: text
        ? 'Text extracted — it will be read when you analyse the change'
        : unsupportedFormat
          ? 'This file format cannot be read as text — .doc, .xls and .ppt are stored but not parsed'
          : 'Could not read this file — a scanned PDF has no text layer',
      extraction: { rawText: text, textAvailable: Boolean(text) },
    },
  });

  /**
   * Propose what this is: a new version of something already on file, or new material. Matched on
   * the name's stem, because for an upload made here there is no slot to infer it from — and an
   * unanswered question would default every document to "new", quietly skipping the comparison
   * that is the whole reason for the mode.
   */
  const stem = documentStem(params.fileName);
  const current = stem
    ? await prisma.referenceFile.findMany({
        where: { projectId: params.projectId, supersededAt: null, id: { not: file.id } },
        orderBy: { uploadedAt: 'desc' },
      })
    : [];
  const predecessor = current.find((candidate) => documentStem(candidate.fileName) === stem) ?? null;

  await prisma.planChangeDocument.create({
    data: {
      changeId: params.changeId,
      referenceId: file.id,
      supersedesReferenceId: predecessor?.id ?? null,
    },
  });
  await prisma.planChange.update({ where: { id: params.changeId }, data: invalidateReading(change.status) });

  return {
    file,
    proposedReplacement: predecessor?.fileName ?? null,
    documents: await prisma.planChangeDocument.findMany({
      where: { changeId: params.changeId },
      orderBy: { createdAt: 'asc' },
    }),
  };
}

/**
 * The PM says whether a document is a new version of something, and of what.
 *
 * Nothing else can answer this reliably. `documentStem` proposes from the file name and the upload
 * slot proposes for uploads made elsewhere, and both guesses are wrong often enough to matter: a
 * genuinely different document dropped into the description slot would be paired with an unrelated
 * predecessor, and a revised SOW named differently from its previous version reads as brand-new.
 *
 * The difference is not cosmetic. A paired document is compared against its predecessor and that
 * predecessor is excluded from "already on file"; an unpaired one is read as new material and
 * checked against everything. So the guess proposes and the PM settles it.
 */
export async function setPlanChangeDocumentReplaces(params: {
  projectId: string;
  changeId: string;
  referenceId: string;
  supersedesReferenceId: string | null;
}) {
  const change = await prisma.planChange.findFirst({ where: { id: params.changeId, projectId: params.projectId } });
  if (!change) throw notFound('Plan change not found');
  if (change.status === PlanChangeStatus.APPLIED || change.status === PlanChangeStatus.DISMISSED) {
    throw conflict('This change has already been applied or dismissed');
  }
  if (params.supersedesReferenceId === params.referenceId) {
    // A document compared against itself reports no change at all, which reads as the analysis
    // having nothing to say rather than as the pairing being nonsense.
    throw badRequest('A document cannot be a new version of itself');
  }
  if (params.supersedesReferenceId) {
    const target = await prisma.referenceFile.findFirst({
      where: { id: params.supersedesReferenceId, projectId: params.projectId },
    });
    if (!target) throw notFound('The document it replaces is not an upload on this project');
  }

  await prisma.planChangeDocument.update({
    where: { changeId_referenceId: { changeId: params.changeId, referenceId: params.referenceId } },
    data: { supersedesReferenceId: params.supersedesReferenceId },
  });
  await prisma.planChange.update({ where: { id: params.changeId }, data: invalidateReading(change.status) });

  return prisma.planChangeDocument.findMany({
    where: { changeId: params.changeId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Cuts an upload loose from every change that mentions it, so the file itself can be deleted.
 *
 * `PlanChangeDocument.referenceId` carries no foreign key — deleting the upload without this would
 * leave rows pointing at a file that no longer exists, and the change panel would render them as
 * "(file removed)" for ever with no way to clear them.
 *
 * An **applied** change is left alone. Its rows are the record of what it carried, and a history
 * that quietly loses entries when somebody tidies up the uploads directory is not a history.
 */
export async function detachReferenceFromChanges(projectId: string, referenceId: string) {
  const open = await prisma.planChange.findMany({
    where: { projectId, status: { in: [PlanChangeStatus.DRAFT, PlanChangeStatus.ANALYZED] } },
    select: { id: true, status: true },
  });
  if (!open.length) return;

  const ids = open.map((change) => change.id);
  await prisma.planChangeDocument.deleteMany({ where: { changeId: { in: ids }, referenceId } });
  // A row whose *predecessor* was deleted keeps its place but loses the comparison it promised.
  await prisma.planChangeDocument.updateMany({
    where: { changeId: { in: ids }, supersedesReferenceId: referenceId },
    data: { supersedesReferenceId: null },
  });
  // The files this upload replaced are not touched here: `removeReference`, which runs next, finds
  // them by `supersededById` and makes them current again. Clearing the pointer here first is what
  // used to strand them — marked replaced by a file that no longer existed.

  const analysed = open.filter((change) => change.status === PlanChangeStatus.ANALYZED).map((change) => change.id);
  if (analysed.length) {
    await prisma.planChange.updateMany({
      where: { id: { in: analysed } },
      data: { status: PlanChangeStatus.DRAFT, impact: Prisma.DbNull, analyzedAt: null },
    });
  }
}

/**
 * Changing what a change contains invalidates any impact already measured for it — the reading on
 * screen would otherwise describe a different change from the one now recorded.
 */
function invalidateReading(status: PlanChangeStatus) {
  return status === PlanChangeStatus.ANALYZED
    ? { status: PlanChangeStatus.DRAFT, impact: Prisma.DbNull, analyzedAt: null }
    : {};
}

/**
 * Opens change mode, or returns the change already open.
 *
 * Refused before the project has a confirmed governance model: there is no plan to change yet, and
 * the right move then is to run the analysis itself rather than a delta against nothing.
 */
export async function startPlanChange(projectId: string, actorId: string) {
  const decision = await prisma.approachDecision.findFirst({ where: { projectId, active: true } });
  if (!decision) {
    throw badRequest(
      'This project has no confirmed governance model yet, so there is no plan to change — run Analyze planning needs instead.',
    );
  }

  const existing = await currentPlanChange(projectId);
  if (existing) return existing;

  return prisma.planChange.create({ data: { projectId, createdById: actorId } });
}

/**
 * Points the open change at a document that has just replaced an earlier one.
 *
 * Called from the upload route rather than from `input.service`, which owns uploads: `rules` already
 * imports `input`, so the reverse would be a cycle. A route composing two services is the ordinary
 * way out of that, and this is the only place the two meet.
 *
 * Silent when no change is open — most uploads are not part of one, and an upload must never fail
 * because of bookkeeping that is beside the point.
 */
export async function linkUploadToOpenChange(params: {
  projectId: string;
  newReferenceId: string;
  supersededId: string | null;
}) {
  const change = await currentPlanChange(params.projectId);
  if (!change) return null;

  // Added, not assigned. The previous version of this replaced the change's single document, so
  // uploading a second file silently pushed the first one out of the change.
  await prisma.planChangeDocument.upsert({
    where: { changeId_referenceId: { changeId: change.id, referenceId: params.newReferenceId } },
    create: {
      changeId: change.id,
      referenceId: params.newReferenceId,
      supersedesReferenceId: params.supersededId,
    },
    update: { supersedesReferenceId: params.supersededId },
  });

  return prisma.planChange.update({
    where: { id: change.id },
    data: invalidateReading(change.status),
  });
}

export async function updatePlanChange(params: { projectId: string; changeId: string; note?: string | null }) {
  const change = await prisma.planChange.findFirst({ where: { id: params.changeId, projectId: params.projectId } });
  if (!change) throw notFound('Plan change not found');
  if (change.status !== PlanChangeStatus.DRAFT && change.status !== PlanChangeStatus.ANALYZED) {
    throw conflict('This change has already been applied or dismissed');
  }

  return prisma.planChange.update({
    where: { id: params.changeId },
    data: {
      ...(params.note !== undefined ? { note: params.note } : {}),
      ...invalidateReading(change.status),
    },
  });
}

/** Runs the delta call and stores the impact for the PM to review. Does not change the plan. */
export async function runPlanChangeAnalysis(projectId: string, changeId: string, actorId: string) {
  const [project, change, decision] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.planChange.findFirst({ where: { id: changeId, projectId } }),
    prisma.approachDecision.findFirst({ where: { projectId, active: true } }),
  ]);
  if (!project) throw notFound('Project not found');
  if (!change) throw notFound('Plan change not found');
  if (!decision) throw badRequest('This project has no confirmed governance model to measure a change against');

  const previous = await prisma.aiApproachSuggestion.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  if (!previous) {
    throw badRequest('There is no analysis to compare against — run Analyze planning needs first.');
  }

  // Whatever has been uploaded since the last analysis is proposed as part of this change before it
  // is measured, so a document added after the panel was last open is not quietly left out.
  await suggestPlanChangeDocuments(projectId, changeId);

  const listed = await prisma.planChangeDocument.findMany({ where: { changeId }, orderBy: { createdAt: 'asc' } });
  const referenceIds = listed.flatMap((document) =>
    [document.referenceId, document.supersedesReferenceId].filter((id): id is string => Boolean(id)),
  );
  const files = referenceIds.length
    ? await prisma.referenceFile.findMany({ where: { id: { in: referenceIds }, projectId } })
    : [];
  const fileById = new Map(files.map((file) => [file.id, file]));

  const changedDocuments = listed
    .map((document) => {
      const text = documentText(fileById.get(document.referenceId) ?? null);
      if (!text) return null;
      const replaced = document.supersedesReferenceId
        ? documentText(fileById.get(document.supersedesReferenceId) ?? null)
        : null;
      return { ...text, replaces: replaced };
    })
    .filter((entry): entry is { label: string; text: string; replaces: { label: string; text: string } | null } =>
      entry !== null,
    );

  if (!change.note?.trim() && !changedDocuments.length) {
    throw badRequest(
      'Describe what changed, or upload a document the analysis can read — there is nothing here to compare.',
    );
  }

  /**
   * Everything else the project currently holds.
   *
   * `newFindings` asks for contradictions between the change and what was already on file; without
   * this the model could not see what is already on file and was being asked for something it had no
   * way to produce. A whole project's corpus is a few thousand tokens — cents — and output is the
   * expensive half, so this is close to free and makes that answer real.
   */
  const inChange = new Set(referenceIds);
  const others = await prisma.referenceFile.findMany({
    where: { projectId, supersededAt: null, id: { notIn: [...inChange] } },
    orderBy: { uploadedAt: 'asc' },
  });
  const otherDocuments = others
    .map((file) => documentText(file))
    .filter((entry): entry is { label: string; text: string } => entry !== null);

  const [generated, definitions, assessmentRules] = await Promise.all([
    prisma.planningDocument.findMany({
      where: { projectId, status: { not: 'NOT_GENERATED' } },
      select: { name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.documentDefinition.findMany({ where: { projectType: project.type }, select: { name: true } }),
    // The Missing Information / Missing Documents rules and where each stands, so the same call can
    // say which of them this change moves — applied on Apply without re-running the assessment.
    assessmentRulesForChange(projectId),
  ]);

  const impact = await analyzePlanChange({
    projectName: project.name,
    projectType: project.type,
    approach: decision.approach,
    note: change.note,
    changedDocuments,
    otherDocuments,
    previous: {
      summary: previous.summary ?? previous.rationale ?? '',
      overview: (previous.overview as unknown as OverviewSection[]) ?? [],
      gaps: (previous.planningGaps as unknown as PlanningGap[]) ?? [],
      findings: (previous.findings as unknown as AnalysisFinding[]) ?? [],
    },
    generatedDocuments: generated.map((document) => document.name),
    catalogDocuments: [...new Set(definitions.map((definition) => definition.name))],
    assessmentRules,
  });

  const updated = await prisma.planChange.update({
    where: { id: changeId },
    data: {
      status: PlanChangeStatus.ANALYZED,
      impact: impact as unknown as Prisma.InputJsonValue,
      analyzedAt: new Date(),
    },
  });

  await logEvent({
    projectId,
    actorId,
    actorType: 'AGENT',
    type: 'PLAN_CHANGE_ANALYZED',
    title: impact.summary || 'Plan change analysed',
    detail: `${changedDocuments.length} changed document(s) read against ${otherDocuments.length} already on file · ${impact.changedOverview.length} block(s) changed · ${impact.newGaps.length} new gap(s) · ${impact.closedGaps.length} closed · ${impact.affectedDocuments.length} document(s) affected · ${impact.assessmentUpdates?.length ?? 0} assessment rule(s) moved`,
    payload: { changeId, affected: impact.affectedDocuments.map((entry) => entry.documentName) },
  });

  return updated;
}

/**
 * The PM's gate. Merges the delta into a new snapshot and moves the plan.
 *
 * Four things happen and all of them are deterministic — no second model call:
 *   1. a NEW immutable snapshot, linked back to the one it was merged from;
 *   2. the PM action center rebuilt from the merged gaps;
 *   3. affected documents **flagged**, never rewritten, unapproved or deleted;
 *   4. an audit event.
 */
export async function applyPlanChange(projectId: string, changeId: string, actorId: string) {
  const change = await prisma.planChange.findFirst({
    where: { id: changeId, projectId },
    include: { documents: true },
  });
  if (!change) throw notFound('Plan change not found');
  const listedDocuments = change.documents;
  if (change.status !== PlanChangeStatus.ANALYZED) {
    throw badRequest('Analyze the change before applying it');
  }

  const previous = await prisma.aiApproachSuggestion.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  if (!previous) throw badRequest('There is no analysis to apply the change to');

  const impact = change.impact as unknown as PlanChangeImpact;
  const previousPrimary: ScoredApproach = {
    approach: previous.recommendedApproach,
    score: previous.confidence,
    reasons: (previous.reasons as unknown as string[]) ?? [],
    evidence: normalizeEvidence(previous.evidence),
    criteria: (previous.candidateValues as unknown as ScoredApproach['criteria']) ?? [],
  };
  const previousAlternatives = ((previous.alternatives as unknown as ScoredApproach[]) ?? []).map((entry) => ({
    ...entry,
    evidence: normalizeEvidence(entry.evidence),
  }));

  const merged = mergeSnapshot(
    {
      summary: previous.summary ?? previous.rationale ?? '',
      overview: (previous.overview as unknown as OverviewSection[]) ?? [],
      gaps: (previous.planningGaps as unknown as PlanningGap[]) ?? [],
      findings: (previous.findings as unknown as AnalysisFinding[]) ?? [],
      approaches: [previousPrimary, ...previousAlternatives],
    },
    impact,
  );

  const [primary, ...alternatives] = merged.approaches;

  // A new snapshot, never an edit. `AiApproachSuggestion` is immutable by design so that "what was
  // promised at each point" survives; `changeOfId` is what turns that into a readable chain.
  const snapshot = await prisma.aiApproachSuggestion.create({
    data: {
      projectId,
      changeOfId: previous.id,
      recommendedApproach: primary?.approach ?? previous.recommendedApproach,
      confidence: Math.round(primary?.score ?? previous.confidence),
      confidenceLevel: previous.confidenceLevel,
      rationale: merged.summary,
      summary: merged.summary,
      reasons: (primary?.reasons ?? []) as unknown as Prisma.InputJsonValue,
      evidence: (primary?.evidence ?? []) as unknown as Prisma.InputJsonValue,
      risks: [] as unknown as Prisma.InputJsonValue,
      alternatives: alternatives as unknown as Prisma.InputJsonValue,
      candidateValues: (primary?.criteria ?? []) as unknown as Prisma.InputJsonValue,
      overview: merged.overview as unknown as Prisma.InputJsonValue,
      planningGaps: merged.gaps as unknown as Prisma.InputJsonValue,
      findings: merged.findings as unknown as Prisma.InputJsonValue,
      approachMode: previous.approachMode,
      aiProvider: impact.provider,
    },
  });

  // The merged gaps are the project's open questions now, so the action center follows them. A gap
  // the change closed disappears from the list; a new one arrives with its document already linked.
  // (Once the project has an assessment this stands down, and the assessment update below owns them.)
  const openActions = await syncPlanningActions(projectId, merged.gaps);

  /**
   * Missing Information and Missing Documents follow the change too: the rules the change call said
   * it moved are merged into a new assessment snapshot and their PM actions updated — no further
   * model call. Risks and conflicts, and every rule the change did not touch, keep their last
   * assessed result until the PM re-assesses.
   */
  const assessment = await applyAssessmentUpdates({
    projectId,
    updates: impact.assessmentUpdates ?? [],
    actorId,
    changeSummary: impact.summary,
  });

  /**
   * Affected documents are **flagged only**. An approved document is something the PM signed off,
   * and regenerating, unapproving or deleting it on their behalf is the one thing this application
   * does not do — the flag says what is wrong and the PM decides what happens next.
   */
  let flagged = 0;
  for (const entry of impact.affectedDocuments) {
    const { count } = await prisma.planningDocument.updateMany({
      where: { projectId, name: entry.documentName, status: { not: 'NOT_GENERATED' } },
      data: { staleReason: entry.reason, staleSince: new Date() },
    });
    flagged += count;
  }

  /**
   * Applying is the moment a replacement becomes true, so the documents this change replaced leave
   * the current set now — not when the PM merely claimed the relationship on the panel.
   *
   * Until this point the claim only shapes the comparison; a change the PM discards must leave the
   * project exactly as it found it.
   */
  // Pointed at the replacement as well as timestamped: deleting that replacement later is what
  // brings the replaced version back (`removeReference`), and it finds it by this pointer.
  for (const document of listedDocuments) {
    if (!document.supersedesReferenceId) continue;
    await prisma.referenceFile.updateMany({
      where: { id: document.supersedesReferenceId, projectId, supersededAt: null },
      data: { supersededAt: new Date(), supersededById: document.referenceId },
    });
  }

  const applied = await prisma.planChange.update({
    where: { id: changeId },
    data: { status: PlanChangeStatus.APPLIED, analysisId: snapshot.id, appliedAt: new Date() },
  });

  await logEvent({
    projectId,
    actorId,
    actorType: 'PM',
    type: 'PLAN_CHANGED',
    title: impact.summary || 'Plan change applied',
    detail: `${flagged} document(s) flagged as out of date · ${
      assessment ? `assessment: ${assessment.nowMissing} now missing, ${assessment.settled} settled` : `${openActions} PM action(s) open`
    } · ${impact.approach.stillFits ? `${primary?.approach} still fits` : `${primary?.approach} may no longer fit${impact.approach.suggested ? ` — consider ${impact.approach.suggested}` : ''}`}`,
    payload: { changeId, snapshotId: snapshot.id, flagged, assessmentRunId: assessment?.runId ?? null },
  });

  return { change: applied, snapshotId: snapshot.id, flagged, openActions, assessment };
}

/** Abandons a change. Kept rather than deleted — "we considered this and decided against it" is history. */
export async function dismissPlanChange(projectId: string, changeId: string, actorId: string) {
  const change = await prisma.planChange.findFirst({ where: { id: changeId, projectId } });
  if (!change) throw notFound('Plan change not found');
  if (change.status === PlanChangeStatus.APPLIED) throw conflict('An applied change cannot be dismissed');

  const dismissed = await prisma.planChange.update({
    where: { id: changeId },
    data: { status: PlanChangeStatus.DISMISSED },
  });

  await logEvent({
    projectId,
    actorId,
    actorType: 'PM',
    type: 'PLAN_CHANGE_DISMISSED',
    title: change.note?.slice(0, 80) || 'Plan change dismissed',
    detail: 'The change was recorded and then set aside; the plan is unchanged.',
    payload: { changeId },
  });

  return dismissed;
}

/** Every change ever recorded on this project, newest first — the Plan history screen. */
export async function planChangeHistory(projectId: string) {
  const changes = await prisma.planChange.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    include: {
      createdBy: { select: { id: true, name: true, initials: true } },
      documents: { orderBy: { createdAt: 'asc' } },
    },
  });

  const referenceIds = changes.flatMap((change) =>
    change.documents.flatMap((document) =>
      [document.referenceId, document.supersedesReferenceId].filter((id): id is string => Boolean(id)),
    ),
  );
  const files = referenceIds.length
    ? await prisma.referenceFile.findMany({
        where: { id: { in: referenceIds } },
        select: { id: true, fileName: true },
      })
    : [];
  const nameById = new Map(files.map((file) => [file.id, file.fileName]));

  return changes.map((change) => ({
    id: change.id,
    note: change.note,
    status: change.status,
    createdAt: change.createdAt,
    analyzedAt: change.analyzedAt,
    appliedAt: change.appliedAt,
    createdBy: change.createdBy,
    /** File names rather than ids: a deleted upload should still read as a name in the history. */
    documents: change.documents.map((document) => ({
      fileName: nameById.get(document.referenceId) ?? '(file removed)',
      replacesFileName: document.supersedesReferenceId
        ? (nameById.get(document.supersedesReferenceId) ?? '(file removed)')
        : null,
    })),
    impact: change.impact as unknown as PlanChangeImpact | null,
  }));
}
