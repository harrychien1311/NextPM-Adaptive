/**
 * Checklist-driven readiness: how far a project meets what *its customer* requires.
 *
 * The input-form readiness score answers "how much of our own form is filled in". Useful, but it
 * is our question, not the customer's. LGCNS and SKAX each hand us a checklist their project has
 * to pass, so this module measures the project against that instead — the number a PM actually
 * gets asked about.
 *
 * Three passes, cheapest and most certain first:
 *
 *  1. **The source's own scoping.** An item the customer's document already excludes (AGS's
 *     범위 외) is NOT_APPLICABLE before anything else looks at it.
 *  2. **Deterministic.** Where a checklist item names a project input field almost verbatim, the
 *     verified input answers it. Free, exact, no model. `lib/checklist-scoring.ts` keeps this
 *     narrow on purpose.
 *  3. **Skill 3.** Everything still open goes to the model, with the project's verified inputs and
 *     document text as its only evidence, and it must cite what a MET rests on. No mock fallback:
 *     without a provider those items stay UNKNOWN.
 *
 * A PM verdict outranks all three and is never overwritten by a re-run.
 *
 * Re-assessment after a document is approved deliberately re-examines **only the items that are
 * not already MET**. An approved document can add evidence, never remove it, so re-checking a MET
 * item cannot change the answer — it would just cost tokens. The work shrinks as the project
 * matures, which is the opposite of how this usually goes.
 */

import { AssessmentSource, ChecklistStatus, DocumentStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/http-error';
import {
  computeChecklistScore,
  matchInputEvidence,
  sourceMarksNotApplicable,
  type ChecklistScore,
} from '../../lib/checklist-scoring';
import { isRecognised, matchCustomer } from '../../lib/customer-match';
import { assessChecklistItems, type ChecklistVerdict } from '../ai/provider';
import { logEvent } from '../audit/audit.service';

/** How much of each document the model gets as evidence. Enough to quote, small enough to batch. */
const DOCUMENT_EXCERPT_CHARS = 2_000;

/**
 * How many checklist items go into one model call. The two checklists we have are 29 and 37 items,
 * so they fit in a single call each; the cap is here so a 300-item checklist added later degrades
 * into several calls instead of one oversized request that gets truncated.
 */
const ITEMS_PER_CALL = 40;

const VERDICTS: Record<ChecklistVerdict, ChecklistStatus> = {
  MET: ChecklistStatus.MET,
  PARTIAL: ChecklistStatus.PARTIAL,
  NOT_MET: ChecklistStatus.NOT_MET,
  NOT_APPLICABLE: ChecklistStatus.NOT_APPLICABLE,
  UNKNOWN: ChecklistStatus.UNKNOWN,
};

// ---------------------------------------------------------------------------
// Finding the checklist that applies to a project
// ---------------------------------------------------------------------------

/**
 * Resolves the project's free-text customer name to a library checklist. Returns null — not an
 * error — when the project's customer is unknown to the library: most projects will be, and a
 * project without a customer checklist is a normal state, not a failure.
 */
export async function activeChecklistForProject(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const customers = await prisma.customer.findMany({
    where: { active: true },
    include: { checklists: { where: { active: true }, include: { items: { orderBy: { order: 'asc' } } } } },
  });

  /**
   * `isRecognised`, not a plain match: readiness answers "how far does this project meet what
   * *its customer* requires". Falling back to the house default means nobody knows who the
   * customer is, and auditing a project against a checklist on that basis would put a number in
   * front of the PM that means nothing. Templates and branding do fall back — a house template is
   * a sensible default; a house audit is not.
   */
  const match = matchCustomer(project.customer, customers);
  if (!match || !isRecognised(match) || !match.customer.checklists.length) return null;

  return {
    project,
    customer: match.customer,
    confidence: match.confidence,
    matchedOn: match.matchedOn,
    checklist: match.customer.checklists[0],
  };
}

// ---------------------------------------------------------------------------
// Reading the assessment
// ---------------------------------------------------------------------------

export async function checklistReadiness(projectId: string) {
  const resolved = await activeChecklistForProject(projectId);
  if (!resolved) {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    return {
      applies: false as const,
      typedCustomer: project?.customer ?? null,
      reason: project?.customer
        ? `No checklist in the customer library matches “${project.customer}”.`
        : 'This project has no customer set, so no customer checklist applies.',
    };
  }

  const assessment = await prisma.projectChecklistAssessment.findUnique({
    where: { projectId_checklistId: { projectId, checklistId: resolved.checklist.id } },
    include: { items: true },
  });

  const byItem = new Map((assessment?.items ?? []).map((row) => [row.checklistItemId, row]));

  const items = resolved.checklist.items.map((item) => {
    const row = byItem.get(item.id);
    return {
      id: item.id,
      order: item.order,
      // Both languages travel together. The screen reads English; the original is what the PM
      // quotes back to the customer and what they search their own file for, so neither is
      // dropped and the UI decides how to show the pair.
      section: item.section,
      sectionEn: item.sectionEn,
      text: item.text,
      textEn: item.textEn,
      guidance: item.guidance,
      guidanceEn: item.guidanceEn,
      status: row?.status ?? ChecklistStatus.UNKNOWN,
      source: row?.source ?? null,
      evidence: row?.evidence ?? null,
      note: row?.note ?? null,
    };
  });

  const score = computeChecklistScore(items);

  // Grouped the way the customer's own document groups it, so a PM can talk to the customer
  // about "변경관리" rather than about item 17.
  // Keyed on the source's own heading — that is the identity — with the English reading carried
  // alongside so the bar can be labelled in the interface's language.
  const bySection = new Map<string, { english: string | null; rows: typeof items }>();
  for (const item of items) {
    const key = item.section ?? 'Ungrouped';
    const existing = bySection.get(key);
    bySection.set(key, {
      english: existing?.english ?? item.sectionEn ?? null,
      rows: [...(existing?.rows ?? []), item],
    });
  }

  return {
    applies: true as const,
    customer: { id: resolved.customer.id, key: resolved.customer.key, name: resolved.customer.name },
    match: { confidence: resolved.confidence, matchedOn: resolved.matchedOn, typed: resolved.project.customer },
    checklist: {
      id: resolved.checklist.id,
      name: resolved.checklist.name,
      version: resolved.checklist.version,
      sourceFile: resolved.checklist.sourceFile,
    },
    assessment: {
      assessedAt: assessment?.assessedAt ?? null,
      stale: assessment?.stale ?? true,
      runState: assessment?.runState ?? 'IDLE',
      lastError: assessment?.lastError ?? null,
      aiProvider: assessment?.aiProvider ?? 'none',
    },
    score,
    items,
    sections: [...bySection.entries()].map(([section, group]) => ({
      section,
      sectionEn: group.english,
      ...computeChecklistScore(group.rows),
      total: group.rows.length,
    })),
  };
}

/** Just the number, for the dashboard and the program roll-up. Null when no checklist applies. */
export async function checklistScoreForProject(projectId: string): Promise<(ChecklistScore & { stale: boolean }) | null> {
  const assessment = await prisma.projectChecklistAssessment.findFirst({
    where: { projectId },
    include: { items: { select: { status: true } } },
  });
  if (!assessment) return null;
  return { ...computeChecklistScore(assessment.items), stale: assessment.stale };
}

// ---------------------------------------------------------------------------
// Running an assessment
// ---------------------------------------------------------------------------

/**
 * Re-assesses the project against its customer's checklist.
 *
 * `onlyUnmet` is what makes the automatic re-run after an approval affordable: an approved
 * document can only add evidence, so an item already MET cannot become un-MET and does not need
 * to be sent to the model again.
 */
export async function runChecklistAssessment(params: {
  projectId: string;
  actorId?: string | null;
  onlyUnmet?: boolean;
}) {
  const resolved = await activeChecklistForProject(params.projectId);
  if (!resolved) throw badRequest('No customer checklist applies to this project.');

  const { checklist, customer, project } = resolved;

  const assessment = await prisma.projectChecklistAssessment.upsert({
    where: { projectId_checklistId: { projectId: params.projectId, checklistId: checklist.id } },
    create: { projectId: params.projectId, checklistId: checklist.id, runState: 'RUNNING' },
    update: { runState: 'RUNNING', lastError: null },
    include: { items: true },
  });

  try {
    const [values, documents, decision] = await Promise.all([
      prisma.projectInputValue.findMany({
        where: { projectId: params.projectId, NOT: { value: null } },
        include: { definition: true },
      }),
      prisma.planningDocument.findMany({
        where: { projectId: params.projectId, status: { not: DocumentStatus.NOT_GENERATED } },
        include: { sections: { orderBy: { order: 'asc' } } },
      }),
      prisma.approachDecision.findFirst({ where: { projectId: params.projectId, active: true } }),
    ]);

    const inputs = values.map((value) => ({
      label: value.definition.label,
      value: value.value!,
      verified: value.verified,
    }));

    const existing = new Map(assessment.items.map((row) => [row.checklistItemId, row]));

    // --- passes 1 and 2: free, exact, no model.
    const resolvedNow = new Map<string, { status: ChecklistStatus; source: AssessmentSource; evidence: string; note: string }>();
    const openItems: typeof checklist.items = [];

    for (const item of checklist.items) {
      const previous = existing.get(item.id);

      // A PM verdict is final — a re-run never argues with it.
      if (previous?.source === AssessmentSource.PM) continue;

      // An approval can only add evidence, so a MET item cannot change. Skip it and save the call.
      if (params.onlyUnmet && previous?.status === ChecklistStatus.MET) continue;

      if (sourceMarksNotApplicable(item)) {
        resolvedNow.set(item.id, {
          status: ChecklistStatus.NOT_APPLICABLE,
          source: AssessmentSource.DETERMINISTIC,
          evidence: 'The customer’s own checklist scopes this item out.',
          note: 'Excluded from the score.',
        });
        continue;
      }

      const match = matchInputEvidence(item, inputs);
      if (match) {
        resolvedNow.set(item.id, { ...match, source: AssessmentSource.DETERMINISTIC });
        continue;
      }

      openItems.push(item);
    }

    // --- pass 3: the model, in batches, on whatever is left.
    let provider: 'anthropic' | 'none' = 'none';
    const verifiedInputs = inputs.filter((input) => input.verified).map(({ label, value }) => ({ label, value }));
    const documentEvidence = documents.map((document) => ({
      name: document.name,
      status: document.status,
      excerpt: document.sections
        .filter((section) => section.included && section.content)
        .map((section) => `${section.title}: ${section.content}`)
        .join('\n')
        .slice(0, DOCUMENT_EXCERPT_CHARS),
    }));

    for (let index = 0; index < openItems.length; index += ITEMS_PER_CALL) {
      const batch = openItems.slice(index, index + ITEMS_PER_CALL);
      const output = await assessChecklistItems({
        projectName: project.name,
        projectType: project.type,
        customerName: customer.name,
        approach: decision?.approach ?? null,
        verifiedInputs,
        documents: documentEvidence,
        items: batch.map((item) => ({
          id: item.id,
          section: item.section,
          text: item.text,
          guidance: item.guidance,
        })),
      });
      if (output.provider === 'anthropic') provider = 'anthropic';

      const known = new Set(batch.map((item) => item.id));
      for (const verdict of output.verdicts) {
        // The model must not invent ids, and a verdict for an item outside this batch is a bug
        // in its output, not evidence about a different item.
        if (!known.has(verdict.id)) continue;
        const status = VERDICTS[verdict.status];
        if (!status) continue;
        resolvedNow.set(verdict.id, {
          status,
          source: AssessmentSource.AI,
          evidence: verdict.evidence?.slice(0, 600) ?? '',
          note: verdict.reason?.slice(0, 600) ?? '',
        });
      }
    }

    // --- persist. Items nothing resolved keep whatever they had, which is UNKNOWN by default.
    await prisma.$transaction(
      [...resolvedNow.entries()].map(([checklistItemId, row]) =>
        prisma.checklistAssessmentItem.upsert({
          where: { assessmentId_checklistItemId: { assessmentId: assessment.id, checklistItemId } },
          create: { assessmentId: assessment.id, checklistItemId, ...row },
          update: row,
        }),
      ),
    );

    const fresh = await prisma.checklistAssessmentItem.findMany({
      where: { assessmentId: assessment.id },
      select: { status: true },
    });
    // Items never written yet are UNKNOWN, so the denominator must be the checklist, not the rows.
    const padded = [
      ...fresh,
      ...Array(Math.max(0, checklist.items.length - fresh.length)).fill({ status: ChecklistStatus.UNKNOWN }),
    ];
    const score = computeChecklistScore(padded);

    await prisma.projectChecklistAssessment.update({
      where: { id: assessment.id },
      data: {
        score: score.score,
        stale: false,
        runState: 'IDLE',
        lastError: null,
        aiProvider: provider,
        assessedAt: new Date(),
      },
    });

    await logEvent({
      projectId: params.projectId,
      actorId: params.actorId ?? null,
      actorType: params.actorId ? 'PM' : 'AGENT',
      type: 'CHECKLIST_ASSESSED',
      title: `Assessed against ${customer.name}'s ${checklist.name} (v${checklist.version})`,
      detail:
        `${score.score}% of ${score.applicable} applicable items · ${score.met} met, ${score.partial} partial, ` +
        `${score.notMet} not met, ${score.unknown} unknown, ${score.notApplicable} not applicable · ` +
        (provider === 'anthropic' ? 'AI pass ran' : 'no AI provider — open items left unknown'),
      payload: { checklistId: checklist.id, score: score.score, provider },
    });

    return { score, provider, assessed: resolvedNow.size, sentToModel: openItems.length };
  } catch (error) {
    await prisma.projectChecklistAssessment.update({
      where: { id: assessment.id },
      data: { runState: 'ERROR', lastError: error instanceof Error ? error.message : 'Unexpected error' },
    });
    throw error;
  }
}

/**
 * The background re-run after a document is approved.
 *
 * Silent when no customer checklist applies — most projects will be in that state, and it is a
 * normal one, not an error worth logging on every approval.
 */
export async function reassessAfterApproval(projectId: string, actorId?: string | null) {
  const resolved = await activeChecklistForProject(projectId);
  if (!resolved) return;
  await runChecklistAssessment({ projectId, actorId, onlyUnmet: true });
}

/**
 * Marks the assessment out of date. Called when a document is approved or inputs are verified:
 * cheap, synchronous, and honest — the PM sees "out of date" immediately rather than a score that
 * quietly no longer reflects the project.
 */
export async function markAssessmentStale(projectId: string) {
  await prisma.projectChecklistAssessment.updateMany({ where: { projectId }, data: { stale: true } });
}

/**
 * The PM's own verdict on one item. Outranks the deterministic pass and the model, and survives
 * every re-run — `NOT_APPLICABLE` in particular is often a judgement only the PM can make.
 */
export async function setItemVerdict(params: {
  projectId: string;
  checklistItemId: string;
  status: ChecklistStatus;
  note?: string | null;
  actorId: string;
}) {
  const resolved = await activeChecklistForProject(params.projectId);
  if (!resolved) throw badRequest('No customer checklist applies to this project.');

  const item = resolved.checklist.items.find((row) => row.id === params.checklistItemId);
  if (!item) throw notFound('That checklist item is not part of this project’s checklist.');

  const assessment = await prisma.projectChecklistAssessment.upsert({
    where: { projectId_checklistId: { projectId: params.projectId, checklistId: resolved.checklist.id } },
    create: { projectId: params.projectId, checklistId: resolved.checklist.id },
    update: {},
  });

  const row = {
    status: params.status,
    source: AssessmentSource.PM,
    evidence: 'Confirmed by the PM.',
    note: params.note?.slice(0, 600) ?? null,
  };

  await prisma.checklistAssessmentItem.upsert({
    where: { assessmentId_checklistItemId: { assessmentId: assessment.id, checklistItemId: item.id } },
    create: { assessmentId: assessment.id, checklistItemId: item.id, ...row },
    update: row,
  });

  const rows = await prisma.checklistAssessmentItem.findMany({
    where: { assessmentId: assessment.id },
    select: { status: true },
  });
  const padded = [
    ...rows,
    ...Array(Math.max(0, resolved.checklist.items.length - rows.length)).fill({ status: ChecklistStatus.UNKNOWN }),
  ];
  const score = computeChecklistScore(padded);
  await prisma.projectChecklistAssessment.update({ where: { id: assessment.id }, data: { score: score.score } });

  await logEvent({
    projectId: params.projectId,
    actorId: params.actorId,
    actorType: 'PM',
    type: 'CHECKLIST_ITEM_CONFIRMED',
    title: `PM set "${item.text.slice(0, 70)}" to ${params.status}`,
    detail: params.note ?? null,
    payload: { checklistItemId: item.id, status: params.status },
  });

  return { score };
}
