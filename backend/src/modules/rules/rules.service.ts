import { DecisionOutcome, Prisma, ProjectType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/http-error';
import { analyzePlanningNeeds, normalizeEvidence, recommendGovernanceModel } from '../ai/provider';
import { DEFAULT_GOVERNANCE_MODELS, governanceModelMeta } from '../../data/governance-models';
import { logEvent } from '../audit/audit.service';
import { syncDocumentsWithPack } from '../documents/documents.service';
import { buildCustomerSuggestion, syncPlanningActions } from '../input/input.service';

/**
 * This module keeps its original "rules" folder name for a minimal diff, but it no
 * longer runs a deterministic rule engine. The governance-model recommendation is
 * LLM-driven (Skill 1 in modules/ai/provider.ts) — see runEvaluation() below.
 */

interface CandidateField {
  fieldKey: string;
  label: string;
  options: string[];
}

async function loadRecommendationContext(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const [definitions, values, descriptionFile] = await Promise.all([
    prisma.inputFieldDefinition.findMany({ where: { projectType: project.type } }),
    prisma.projectInputValue.findMany({ where: { projectId }, include: { definition: true } }),
    prisma.referenceFile.findFirst({ where: { projectId, group: 'DESCRIPTION' }, orderBy: { uploadedAt: 'desc' } }),
  ]);

  const verifiedInputs = values
    .filter((value) => value.verified && value.value)
    .map((value) => ({ label: value.definition.label, value: value.value! }));

  const fields: CandidateField[] = definitions.map((definition) => ({
    fieldKey: definition.signalKey ?? definition.key,
    label: definition.label,
    options: definition.options,
  }));

  const extraction = descriptionFile?.extraction as { rawText?: string; textAvailable?: boolean } | null;
  const documentText = extraction?.textAvailable && extraction.rawText ? extraction.rawText : null;

  return { project, definitions, values, verifiedInputs, fields, descriptionFile, documentText };
}

/**
 * Runs Skill 1 (recommendGovernanceModel) and stores the result as an immutable
 * AiApproachSuggestion snapshot. Candidate field values only ever fill fields that are
 * still empty and always land as AI_SUGGESTED + unverified — the PM confirms them like
 * any other candidate.
 */
export async function runEvaluation(projectId: string, actorId: string) {
  const { project, definitions, values, verifiedInputs, fields, descriptionFile, documentText } =
    await loadRecommendationContext(projectId);

  const analysis = await recommendGovernanceModel({
    projectName: project.name,
    projectType: project.type,
    verifiedInputs,
    documentText,
    // So each piece of evidence can name the file it came from rather than "the document".
    documentName: descriptionFile?.fileName ?? null,
    fields,
  });

  const valueByDefinition = new Map(values.map((value) => [value.definitionId, value]));
  const definitionBySignal = new Map(definitions.map((definition) => [definition.signalKey ?? definition.key, definition]));

  const appliedCandidates: { fieldKey: string; label: string; value: string }[] = [];
  for (const candidate of analysis.candidates) {
    const definition = definitionBySignal.get(candidate.fieldKey);
    if (!definition) continue;
    const existing = valueByDefinition.get(definition.id);
    if (existing?.source === 'PM_INPUT' && existing.value) continue; // never override a PM answer

    await prisma.projectInputValue.upsert({
      where: { projectId_definitionId: { projectId, definitionId: definition.id } },
      create: { projectId, definitionId: definition.id, value: candidate.value, source: 'AI_SUGGESTED' },
      update: { value: candidate.value, source: 'AI_SUGGESTED', verified: false, conflictNote: null },
    });
    appliedCandidates.push({ fieldKey: candidate.fieldKey, label: definition.label, value: candidate.value });
  }

  const evaluation = await prisma.aiApproachSuggestion.create({
    data: {
      projectId,
      sourceFileId: descriptionFile?.id,
      recommendedApproach: analysis.recommendedApproach,
      confidence: analysis.confidence,
      confidenceLevel: analysis.confidenceLevel,
      rationale: analysis.rationale,
      reasons: analysis.reasons as unknown as Prisma.InputJsonValue,
      evidence: analysis.evidence as unknown as Prisma.InputJsonValue,
      risks: analysis.risks as unknown as Prisma.InputJsonValue,
      alternatives: analysis.alternatives as unknown as Prisma.InputJsonValue,
      summary: analysis.summary,
      candidateValues: appliedCandidates as unknown as Prisma.InputJsonValue,
      aiProvider: analysis.provider,
    },
  });

  await logEvent({
    projectId,
    actorId,
    actorType: 'AGENT',
    type: 'GOVERNANCE_MODEL_RECOMMENDED',
    title: `${analysis.recommendedApproach} recommended · ${analysis.confidence}% confidence`,
    detail: `${appliedCandidates.length} candidate values proposed for PM confirmation · produced by ${analysis.provider}`,
    payload: { evaluationId: evaluation.id, confidence: analysis.confidence, alternatives: analysis.alternatives },
  });

  return evaluation;
}

/**
 * "Analyze planning needs" — the one model call between Project Input and a document pack.
 *
 * Reads every uploaded document plus what the PM typed, and answers in one pass: what the project
 * is, how it should be governed (or how well the PM's own choice fits), what is still missing, and
 * what contradicts itself. The result is stored as an immutable `AiApproachSuggestion` snapshot,
 * the same as the recommendation it replaces, so history stays explainable.
 *
 * `Project.preferredApproach` decides the mode and nothing else does: null asks for advice, a value
 * asks for an assessment of that value.
 */
export async function runPlanningAnalysis(projectId: string, actorId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const [values, references, definitions] = await Promise.all([
    prisma.projectInputValue.findMany({ where: { projectId }, include: { definition: true } }),
    prisma.referenceFile.findMany({ where: { projectId }, orderBy: { uploadedAt: 'asc' } }),
    prisma.documentDefinition.findMany({ where: { projectType: project.type }, orderBy: { name: 'asc' } }),
  ]);

  // Every upload, not only the description document: a contradiction between two files is exactly
  // the kind of finding this call exists to surface, and it cannot see one if it reads only one.
  const documents = references
    .map((file) => {
      const extraction = file.extraction as { rawText?: string; textAvailable?: boolean } | null;
      return extraction?.textAvailable && extraction.rawText
        ? { label: file.fileName, text: extraction.rawText.slice(0, DOCUMENT_CHARS) }
        : null;
    })
    .filter((entry): entry is { label: string; text: string } => entry !== null);

  if (!documents.length) {
    throw badRequest(
      'Upload a project description document first — the analysis reads the documents, and there is nothing to read.',
    );
  }

  const analysis = await analyzePlanningNeeds({
    projectName: project.name,
    projectType: project.type,
    inputs: values
      .filter((value) => value.value)
      .map((value) => ({ label: value.definition.label, value: value.value! })),
    documents,
    preferredApproach: project.preferredApproach,
    catalogDocuments: [...new Set(definitions.map((definition) => definition.name))],
  });

  /**
   * The customer proposal used to ride along with "Verify input". That button is gone, so it rides
   * along here instead — otherwise removing the button would have silently switched off the
   * customer detection that decides which checklist scores the project and whose kickoff template
   * gets filled. Still only a proposal: it is stored for the PM to accept on the banner, never
   * applied.
   */
  if (analysis.customer && !project.customer?.trim()) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        customerSuggestion: (await buildCustomerSuggestion(
          analysis.customer,
          documents,
          project.customer,
        )) as unknown as Prisma.InputJsonValue,
      },
    });
  }

  const primary = analysis.approaches[0];
  const evaluation = await prisma.aiApproachSuggestion.create({
    data: {
      projectId,
      recommendedApproach: primary?.approach ?? project.preferredApproach ?? 'HYBRID',
      confidence: Math.round(primary?.score ?? 0),
      confidenceLevel: analysis.confidenceLevel,
      rationale: analysis.summary,
      reasons: (primary?.reasons ?? []) as unknown as Prisma.InputJsonValue,
      evidence: (primary?.evidence ?? []) as unknown as Prisma.InputJsonValue,
      // Risks of the *approach* stay empty here; document contradictions live in `findings`.
      risks: [] as unknown as Prisma.InputJsonValue,
      // Everything after the first entry is what the PM can switch to — empty in PM_CHOSEN mode.
      alternatives: analysis.approaches.slice(1).map((entry) => ({
        approach: entry.approach,
        score: entry.score,
        rationale: entry.reasons[0] ?? '',
        reasons: entry.reasons,
        evidence: entry.evidence,
        criteria: entry.criteria,
      })) as unknown as Prisma.InputJsonValue,
      summary: analysis.summary,
      candidateValues: [] as unknown as Prisma.InputJsonValue,
      aiProvider: analysis.provider,
      overview: analysis.overview as unknown as Prisma.InputJsonValue,
      planningGaps: analysis.planningGaps as unknown as Prisma.InputJsonValue,
      findings: analysis.findings as unknown as Prisma.InputJsonValue,
      approachMode: analysis.mode,
      // The primary's own criteria ride along on the snapshot via `reasons`/`criteria` in the
      // alternatives shape; the primary keeps its breakdown here so the card can show it.
      ...(primary ? { candidateValues: primary.criteria as unknown as Prisma.InputJsonValue } : {}),
    },
  });

  /**
   * The gaps also become the PM action center on the dashboard. That panel is fed by `ActionItem`
   * rows and nothing used to write any, so it sat empty on every project while the same gaps were
   * already on screen in Planning Review. One analysis, one set of open actions.
   */
  const openActions = await syncPlanningActions(projectId, analysis.planningGaps);

  await logEvent({
    projectId,
    actorId,
    actorType: 'AGENT',
    type: 'GOVERNANCE_MODEL_RECOMMENDED',
    title:
      analysis.mode === 'PM_CHOSEN'
        ? `${primary?.approach} assessed · ${primary?.score}% fit`
        : `${primary?.approach} recommended · ${primary?.score}% fit`,
    detail: `${documents.length} document(s) read · ${analysis.planningGaps.length} planning gap(s) · ${analysis.findings.length} finding(s) · ${openActions} PM action(s) opened`,
    payload: { evaluationId: evaluation.id, mode: analysis.mode },
  });

  return evaluation;
}

/** How much of each uploaded document the analysis reads. Enough to quote, small enough to batch. */
const DOCUMENT_CHARS = 18_000;

export async function latestEvaluation(projectId: string) {
  const evaluation = await prisma.aiApproachSuggestion.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
  if (!evaluation) return null;
  // Snapshots taken before evidence carried both languages hold a plain `string[]`. They are
  // immutable by design, so they are normalised on the way out rather than rewritten in place.
  return { ...evaluation, evidence: normalizeEvidence(evaluation.evidence) };
}


/** Required/conditional document names for this project's type — same for every governance model. */
async function documentPackForProject(projectType: ProjectType) {
  const definitions = await prisma.documentDefinition.findMany({
    where: { projectType },
    orderBy: { order: 'asc' },
  });
  return {
    required: definitions.filter((d) => d.requirement === 'REQUIRED').map((d) => d.name),
    conditional: definitions.filter((d) => d.requirement === 'CONDITIONAL').map((d) => d.name),
  };
}

/** Every scored model (primary + alternatives) for the approach comparison cards. */
export async function approachOptions(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const evaluation = await latestEvaluation(projectId);
  if (!evaluation) return [];

  const pack = await documentPackForProject(project.type);
  const alternatives = (evaluation.alternatives as unknown as { approach: string; score: number; rationale: string }[]) ?? [];

  const entries = [
    { approach: evaluation.recommendedApproach, score: evaluation.confidence, recommended: true },
    ...alternatives.map((alt) => ({ approach: alt.approach, score: alt.score, recommended: false })),
  ];

  /**
   * The model the project actually runs on always gets a card, even when a newer evaluation did not
   * score it.
   *
   * That happens for real: the AI may recommend a model outside the default six, and a later re-run
   * need not list the one the PM chose. Without this the screen renders no card for the project's
   * own governance model — nothing shows as selected, and the confirm button silently acts on
   * whichever card happens to be first.
   */
  const decision = await prisma.approachDecision.findFirst({ where: { projectId, active: true } });
  if (decision && !entries.some((entry) => entry.approach === decision.approach)) {
    entries.push({ approach: decision.approach, score: 0, recommended: false });
  }

  return entries.map((entry) => {
    const meta = governanceModelMeta(entry.approach);
    return {
      approach: entry.approach,
      title: meta.title,
      tagline: meta.tagline,
      summary: meta.summary,
      score: entry.score,
      recommended: entry.recommended,
      pack,
      operatingModel: { rigor: meta.rigor, controls: meta.controls },
    };
  });
}

/**
 * The PM decision gate. Confirming (or overriding with a reason) freezes the
 * document pack as the generation contract and provisions the planning documents.
 */
export async function decideApproach(params: {
  projectId: string;
  approach: string;
  outcome: DecisionOutcome;
  rationale?: string;
  decidedById: string;
}) {
  const { projectId, approach, outcome, rationale, decidedById } = params;
  if (outcome === DecisionOutcome.OVERRIDDEN && !rationale?.trim()) {
    throw badRequest('An override requires a PM rationale');
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const evaluation = await latestEvaluation(projectId);
  if (!evaluation) throw badRequest('Run the governance-model recommendation before confirming a model');

  const meta = governanceModelMeta(approach);
  const pack = await documentPackForProject(project.type);

  const decision = await prisma.$transaction(async (tx) => {
    await tx.approachDecision.updateMany({ where: { projectId, active: true }, data: { active: false } });
    return tx.approachDecision.create({
      data: {
        projectId,
        evaluationId: evaluation.id,
        approach,
        outcome,
        rigor: meta.rigor,
        rationale: rationale?.trim() || null,
        operatingModel: { rigor: meta.rigor, controls: meta.controls } as Prisma.InputJsonValue,
        documentPack: pack as unknown as Prisma.InputJsonValue,
        decidedById,
      },
    });
  });

  await syncDocumentsWithPack(projectId);

  await prisma.project.update({
    where: { id: projectId },
    data: { status: 'ACTIVE' },
  });

  await logEvent({
    projectId,
    actorId: decidedById,
    actorType: 'PM',
    type: outcome === DecisionOutcome.CONFIRMED ? 'APPROACH_CONFIRMED' : 'APPROACH_OVERRIDDEN',
    title: `${approach} governance model ${outcome === DecisionOutcome.CONFIRMED ? 'confirmed' : 'overridden'}`,
    detail: rationale ?? `Generation contract locked with ${pack.required.length} required outputs`,
    payload: { decisionId: decision.id, approach },
  });

  return decision;
}

export async function activeDecision(projectId: string) {
  return prisma.approachDecision.findFirst({
    where: { projectId, active: true },
    include: { decidedBy: { select: { id: true, name: true, initials: true } } },
  });
}

export const CANDIDATE_GOVERNANCE_MODELS = DEFAULT_GOVERNANCE_MODELS;
