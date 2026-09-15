import { DecisionOutcome, Prisma, ProjectType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/http-error';
import { normalizeEvidence, recommendGovernanceModel } from '../ai/provider';
import { DEFAULT_GOVERNANCE_MODELS, governanceModelMeta } from '../../data/governance-models';
import { logEvent } from '../audit/audit.service';
import { syncDocumentsWithPack } from '../documents/documents.service';

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
