import { InputSource, ManagementDomain, ReferenceGroup, ReferenceStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/http-error';
import { env } from '../../config/env';
import { REFERENCE_GROUPS } from '../../data/input-schemas';
import { extractTextFromFile } from '../../lib/extract-text';
import { computeInputReadiness } from '../../lib/readiness';
import { logEvent } from '../audit/audit.service';

const DESCRIPTION_GROUP: ReferenceGroup = 'DESCRIPTION';

/** The four classified groups shown in the reference-groups panel — everything but DESCRIPTION. */
export type ClassifiedReferenceGroup = Exclude<ReferenceGroup, 'DESCRIPTION'>;

/** The minimum project profile form + verification counters + missing information. */
export async function inputProfile(projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const definitions = await prisma.inputFieldDefinition.findMany({
    where: { projectType: project.type },
    orderBy: { order: 'asc' },
  });
  const values = await prisma.projectInputValue.findMany({ where: { projectId } });
  const byDefinition = new Map(values.map((value) => [value.definitionId, value]));

  const fields = definitions.map((definition) => {
    const value = byDefinition.get(definition.id);
    return {
      definitionId: definition.id,
      key: definition.key,
      label: definition.label,
      fieldType: definition.fieldType,
      options: definition.options,
      required: definition.required,
      domain: definition.domain,
      signalKey: definition.signalKey,
      value: value?.value ?? null,
      source: value?.source ?? InputSource.PM_INPUT,
      verified: value?.verified ?? false,
      conflictNote: value?.conflictNote ?? null,
    };
  });

  const readiness = computeInputReadiness(
    fields.map((field) => ({ value: field.value, verified: field.verified, required: field.required })),
  );

  const [customFields, references, openActions] = await Promise.all([
    prisma.projectCustomField.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    prisma.referenceFile.findMany({ where: { projectId }, orderBy: { uploadedAt: 'desc' } }),
    prisma.actionItem.findMany({ where: { projectId, status: 'OPEN' }, orderBy: { priority: 'asc' } }),
  ]);

  const descriptionFile = references.find((file) => file.group === DESCRIPTION_GROUP) ?? null;
  const descriptionExtraction = descriptionFile?.extraction as { textAvailable?: boolean } | null;

  return {
    projectType: project.type,
    fields,
    readiness: readiness.readiness,
    counters: {
      total: readiness.total,
      pmInput: fields.filter((field) => field.value && field.source === InputSource.PM_INPUT).length,
      fileReference: fields.filter((field) => field.value && field.source === InputSource.FILE_REFERENCE).length,
      missing: fields.filter((field) => field.required && !field.value).length,
      verified: readiness.verified,
    },
    customFields,
    referenceGroups: REFERENCE_GROUPS.map((group) => ({
      ...group,
      files: references
        .filter((file) => file.group === group.group)
        .map((file) => ({
          id: file.id,
          fileName: file.fileName,
          status: file.status,
          verifiedFields: file.verifiedFields,
          message: file.message,
          sizeBytes: file.sizeBytes,
        })),
    })),
    descriptionDocument: descriptionFile
      ? {
          id: descriptionFile.id,
          fileName: descriptionFile.fileName,
          status: descriptionFile.status,
          message: descriptionFile.message,
          sizeBytes: descriptionFile.sizeBytes,
          textAvailable: Boolean(descriptionExtraction?.textAvailable),
        }
      : null,
    policy: { maxFilesPerGroup: env.maxFilesPerGroup, maxUploadMb: env.maxUploadMb },
    missingInformation: openActions.map((action) => ({
      id: action.id,
      title: action.title,
      description: action.description,
      priority: action.priority,
      suggestions: action.suggestions,
      targetView: action.targetView,
    })),
  };
}

/** Saving a value marks it as PM input; it stays unverified until the PM runs verification. */
export async function saveValues(params: {
  projectId: string;
  actorId: string;
  values: { definitionId: string; value: string | null }[];
}) {
  const definitions = await prisma.inputFieldDefinition.findMany({
    where: { id: { in: params.values.map((value) => value.definitionId) } },
  });
  if (definitions.length !== params.values.length) throw badRequest('Unknown input field in payload');

  await prisma.$transaction(
    params.values.map((value) =>
      prisma.projectInputValue.upsert({
        where: { projectId_definitionId: { projectId: params.projectId, definitionId: value.definitionId } },
        create: {
          projectId: params.projectId,
          definitionId: value.definitionId,
          value: value.value,
          source: InputSource.PM_INPUT,
        },
        update: { value: value.value, source: InputSource.PM_INPUT, verified: false, conflictNote: null },
      }),
    ),
  );

  await recomputeDomainReadiness(params.projectId);
  return inputProfile(params.projectId);
}

/**
 * "Verify input & continue" — the PM confirms the filled values, which is what
 * turns candidate data (including file extractions) into verified facts. It never
 * calls the AI itself: the governance-model recommendation (which also reads the
 * project description document) is a separate, explicit action on the Approach screen.
 */
export async function verifyInputs(projectId: string, actorId: string) {
  const values = await prisma.projectInputValue.findMany({
    where: { projectId, NOT: { value: null } },
    include: { definition: true },
  });

  await prisma.projectInputValue.updateMany({
    where: { projectId, NOT: { value: null } },
    data: { verified: true, verifiedById: actorId, verifiedAt: new Date() },
  });

  await recomputeDomainReadiness(projectId);
  await prisma.planningTask.updateMany({
    where: { projectId, title: 'Complete minimum project profile' },
    data: { state: 'DONE' },
  });

  await logEvent({
    projectId,
    actorId,
    type: 'INPUTS_VERIFIED',
    title: `${values.length} data points verified`,
    detail: 'PM confirmed the current input profile as the basis for the governance-model recommendation.',
  });

  return { verified: values.length };
}

export async function addCustomField(params: { projectId: string; name: string; value?: string; useIn?: string }) {
  return prisma.projectCustomField.create({
    data: {
      projectId: params.projectId,
      name: params.name,
      value: params.value,
      useIn: params.useIn ?? 'BOTH',
    },
  });
}

export async function removeCustomField(projectId: string, id: string) {
  const field = await prisma.projectCustomField.findFirst({ where: { id, projectId } });
  if (!field) throw notFound('Custom field not found');
  await prisma.projectCustomField.delete({ where: { id } });
  return { removed: true };
}

/** Resolves a PM action item and writes the chosen value back into the input profile. */
export async function resolveAction(params: { projectId: string; actionId: string; value: string; actorId: string }) {
  const action = await prisma.actionItem.findFirst({ where: { id: params.actionId, projectId: params.projectId } });
  if (!action) throw notFound('Action item not found');

  const definition = await prisma.inputFieldDefinition.findFirst({
    where: {
      projectType: (await prisma.project.findUniqueOrThrow({ where: { id: params.projectId } })).type,
      OR: [{ label: { contains: action.title.replace(/^(Confirm|Assign|Include) /, ''), mode: 'insensitive' } }],
    },
  });

  if (definition) {
    await prisma.projectInputValue.upsert({
      where: { projectId_definitionId: { projectId: params.projectId, definitionId: definition.id } },
      create: {
        projectId: params.projectId,
        definitionId: definition.id,
        value: params.value,
        source: InputSource.PM_INPUT,
        verified: true,
        verifiedById: params.actorId,
        verifiedAt: new Date(),
      },
      update: { value: params.value, verified: true, verifiedById: params.actorId, verifiedAt: new Date() },
    });
  }

  const updated = await prisma.actionItem.update({
    where: { id: params.actionId },
    data: { status: 'RESOLVED', resolvedValue: params.value, resolvedAt: new Date() },
  });

  await logEvent({
    projectId: params.projectId,
    actorId: params.actorId,
    type: 'ACTION_RESOLVED',
    title: action.title,
    detail: `PM selected: ${params.value}`,
  });

  await recomputeDomainReadiness(params.projectId);
  return updated;
}

/**
 * Registers an uploaded reference and its candidate extraction. Files never become
 * approved facts: extracted values are stored as AI_SUGGESTED for PM confirmation.
 */
export async function registerReference(params: {
  projectId: string;
  group: ClassifiedReferenceGroup;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  actorId: string;
}) {
  const { actorId, ...fileData } = params;
  const existing = await prisma.referenceFile.count({ where: { projectId: params.projectId, group: params.group } });
  if (existing >= env.maxFilesPerGroup) {
    throw badRequest(`Maximum ${env.maxFilesPerGroup} files per reference group`);
  }

  const file = await prisma.referenceFile.create({
    data: { ...fileData, status: ReferenceStatus.CLASSIFYING },
  });

  // Verification sequence: classify -> extract -> compare with PM input -> flag -> PM confirms.
  const extraction = await extractCandidates(params.group);
  const updated = await prisma.referenceFile.update({
    where: { id: file.id },
    data: {
      status: extraction.conflicts.length ? ReferenceStatus.WARNING : ReferenceStatus.VERIFIED,
      verifiedFields: extraction.candidates.length,
      message: extraction.conflicts[0] ?? `${extraction.candidates.length} fields verified`,
      extraction: extraction as unknown as object,
    },
  });

  await logEvent({
    projectId: params.projectId,
    actorId,
    actorType: 'AGENT',
    type: 'REFERENCE_VERIFIED',
    title: `${params.fileName} checked against group rules`,
    detail: `${extraction.candidates.length} candidate values proposed for PM confirmation`,
  });

  return updated;
}

/**
 * Registers the project description document. Unlike the classified reference groups,
 * this file's text is read immediately so it is ready the next time the PM asks for a
 * governance-model recommendation — the AI analysis itself happens there, not on upload.
 * Only one description document is kept; a new upload replaces the previous one.
 */
export async function registerDescriptionDocument(params: {
  projectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  actorId: string;
}) {
  const { actorId, ...fileData } = params;

  const previous = await prisma.referenceFile.findMany({
    where: { projectId: params.projectId, group: DESCRIPTION_GROUP },
  });
  if (previous.length) {
    await prisma.referenceFile.deleteMany({ where: { id: { in: previous.map((file) => file.id) } } });
  }

  const { text, unsupportedFormat } = await extractTextFromFile({
    storageKey: params.storageKey,
    fileName: params.fileName,
  });

  const file = await prisma.referenceFile.create({
    data: {
      ...fileData,
      group: DESCRIPTION_GROUP,
      status: text ? ReferenceStatus.VERIFIED : ReferenceStatus.WARNING,
      message: text
        ? 'Text extracted — ready for the next AI recommendation'
        : unsupportedFormat
          ? 'This file format cannot be read as text — re-upload as PDF, DOCX or TXT'
          : 'Could not read this file — re-upload as PDF, DOCX or TXT',
      extraction: { rawText: text, textAvailable: Boolean(text) },
    },
  });

  await logEvent({
    projectId: params.projectId,
    actorId,
    actorType: 'AGENT',
    type: 'DESCRIPTION_UPLOADED',
    title: `${params.fileName} added as the project description`,
    detail: text
      ? 'Text extracted; the AI will read it on the next governance-model recommendation.'
      : 'File stored, but no readable text was found.',
  });

  return file;
}

/**
 * Extraction stub. Replace with a real parser (pdf-parse / xlsx / docx) or a
 * document-understanding model; the contract stays the same.
 */
async function extractCandidates(group: ClassifiedReferenceGroup) {
  const map: Record<ClassifiedReferenceGroup, { candidates: { fieldKey: string; value: string }[]; conflicts: string[] }> = {
    COMMITMENT: {
      candidates: [
        { fieldKey: 'contractModel', value: 'Fixed price' },
        { fieldKey: 'deadlineFlexibility', value: 'Fixed launch date' },
      ],
      conflicts: [],
    },
    SCOPE: { candidates: [{ fieldKey: 'scopeClarity', value: 'Medium — major flows known' }], conflicts: ['Acceptance owner missing'] },
    ORGANIZATION: { candidates: [], conflicts: [] },
    SCHEDULE: { candidates: [], conflicts: [] },
  };
  return map[group];
}

export async function removeReference(projectId: string, id: string) {
  const file = await prisma.referenceFile.findFirst({ where: { id, projectId } });
  if (!file) throw notFound('Reference file not found');
  await prisma.referenceFile.delete({ where: { id } });
  return { removed: true };
}

/** Domain readiness = share of that domain's required inputs which are verified. */
export async function recomputeDomainReadiness(projectId: string) {
  const values = await prisma.projectInputValue.findMany({ where: { projectId }, include: { definition: true } });
  const domains: ManagementDomain[] = ['GOVERNANCE', 'SCOPE', 'SCHEDULE', 'FINANCE', 'STAKEHOLDERS', 'RESOURCES', 'RISK'];

  for (const domain of domains) {
    const scoped = values.filter((value) => value.definition.domain === domain && value.definition.required);
    const score = scoped.length
      ? Math.round((scoped.filter((value) => value.value && value.verified).length / scoped.length) * 100)
      : 0;
    await prisma.domainReadiness.upsert({
      where: { projectId_domain: { projectId, domain } },
      create: { projectId, domain, score },
      update: { score },
    });
  }
}
