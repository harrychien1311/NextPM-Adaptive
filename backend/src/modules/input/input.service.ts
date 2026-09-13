import { InputSource, ManagementDomain, ReferenceGroup, ReferenceStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/http-error';
import { env } from '../../config/env';
import { REFERENCE_GROUPS } from '../../data/input-schemas';
import { extractTextFromFile } from '../../lib/extract-text';
import { matchOptionsInText } from '../../lib/option-match';
import { computeInputReadiness } from '../../lib/readiness';
import { extractInputValues, type AiProvider } from '../ai/provider';
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
/**
 * "Verify input" does two things, in this order:
 *
 * 1. **Prefill from the uploaded documents.** Text was already pulled out of every upload
 *    (language-agnostic, no model involved). Stage 1 maps that text onto SELECT options
 *    deterministically; only the fields it cannot resolve are sent to the model in stage 2.
 *    Whatever comes back lands in *empty* fields as AI_SUGGESTED and **unverified** — a document
 *    never becomes an approved fact on its own, and a PM answer is never overwritten. Fields
 *    nothing could answer stay blank for the PM to fill in.
 *
 * 2. **Verify what the PM actually owns.** Values the PM typed are marked verified; the values
 *    this run just suggested are deliberately left unverified, so the next press of the button
 *    is what promotes the ones the PM has reviewed and kept.
 */
export async function verifyInputs(projectId: string, actorId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw notFound('Project not found');

  const [definitions, existingValues, references] = await Promise.all([
    prisma.inputFieldDefinition.findMany({ where: { projectType: project.type }, orderBy: { order: 'asc' } }),
    prisma.projectInputValue.findMany({ where: { projectId } }),
    prisma.referenceFile.findMany({ where: { projectId }, orderBy: { uploadedAt: 'asc' } }),
  ]);

  const valueByDefinition = new Map(existingValues.map((value) => [value.definitionId, value]));
  const documents = references
    .map((file) => {
      const extraction = file.extraction as { rawText?: string; textAvailable?: boolean } | null;
      const text = extraction?.textAvailable && extraction.rawText ? extraction.rawText : null;
      return text ? { label: `${file.group} · ${file.fileName}`, text } : null;
    })
    .filter((document): document is { label: string; text: string } => document !== null);

  // Only fields with no value at all are open for prefill.
  const emptyDefinitions = definitions.filter((definition) => !valueByDefinition.get(definition.id)?.value);

  const suggestions = new Map<string, string>();
  let provider: AiProvider = 'mock';

  if (documents.length && emptyDefinitions.length) {
    const corpus = documents.map((document) => document.text).join('\n\n');

    // Stage 1 — deterministic, free, no tokens spent.
    const matched = matchOptionsInText(
      corpus,
      emptyDefinitions.map((definition) => ({ fieldKey: definition.key, options: definition.options })),
    );
    for (const match of matched) suggestions.set(match.fieldKey, match.value);

    // Stage 2 — the model, for everything stage 1 could not resolve (including any document
    // that is not in English, where literal option matching can never work).
    const unresolved = emptyDefinitions.filter((definition) => !suggestions.has(definition.key));
    if (unresolved.length) {
      const extracted = await extractInputValues({
        projectName: project.name,
        projectType: project.type,
        documents,
        fields: unresolved.map((definition) => ({
          fieldKey: definition.key,
          label: definition.label,
          fieldType: definition.fieldType,
          options: definition.options,
        })),
      });
      provider = extracted.provider;

      const definitionByKey = new Map(unresolved.map((definition) => [definition.key, definition]));
      for (const value of extracted.values) {
        const definition = definitionByKey.get(value.fieldKey);
        if (!definition || !value.value) continue;
        // A SELECT may only ever hold one of its own options — drop anything else rather than
        // writing a value the form cannot render.
        if (definition.options.length && !definition.options.includes(value.value)) continue;
        suggestions.set(definition.key, value.value);
      }
    }

    const definitionByKey = new Map(definitions.map((definition) => [definition.key, definition]));
    for (const [fieldKey, value] of suggestions) {
      const definition = definitionByKey.get(fieldKey);
      if (!definition) continue;
      await prisma.projectInputValue.upsert({
        where: { projectId_definitionId: { projectId, definitionId: definition.id } },
        create: { projectId, definitionId: definition.id, value, source: InputSource.AI_SUGGESTED },
        update: { value, source: InputSource.AI_SUGGESTED, verified: false, conflictNote: null },
      });
    }
  }

  // Verify the PM's own answers. AI suggestions — including the ones just written — stay
  // unverified until the PM has looked at them and pressed the button again.
  const verifiable = await prisma.projectInputValue.findMany({
    where: { projectId, NOT: { value: null }, source: InputSource.PM_INPUT },
  });
  await prisma.projectInputValue.updateMany({
    where: { projectId, NOT: { value: null }, source: InputSource.PM_INPUT },
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
    title: `${verifiable.length} data points verified · ${suggestions.size} prefilled from documents`,
    detail: documents.length
      ? `Read ${documents.length} uploaded document(s); extraction produced by ${provider}.`
      : 'No uploaded documents to read — verified the PM-entered profile only.',
  });

  return {
    verified: verifiable.length,
    prefilled: suggestions.size,
    documentsRead: documents.length,
    stillEmpty: definitions.length - (existingValues.filter((value) => value.value).length + suggestions.size),
    provider,
  };
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
 * Registers an uploaded reference file. Its text is read here, exactly like the project
 * description document — reading a file is cheap and language-agnostic, while deciding what the
 * text *means* is deferred to "Verify input" so the PM controls when a model is called.
 *
 * Files never become approved facts: anything derived from them lands as AI_SUGGESTED for PM
 * confirmation.
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

  const { text, unsupportedFormat } = await extractTextFromFile({
    storageKey: params.storageKey,
    fileName: params.fileName,
  });

  const file = await prisma.referenceFile.create({
    data: {
      ...fileData,
      status: text ? ReferenceStatus.UPLOADED : ReferenceStatus.WARNING,
      message: text
        ? 'Text extracted — press Verify input to read it into the form'
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
    type: 'REFERENCE_UPLOADED',
    title: `${params.fileName} added to ${params.group.toLowerCase()} references`,
    detail: text
      ? `${text.length.toLocaleString()} characters extracted; Verify input will read them into the form.`
      : 'File stored, but no readable text was found.',
  });

  return file;
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

export async function removeReference(projectId: string, id: string) {
  const file = await prisma.referenceFile.findFirst({ where: { id, projectId } });
  if (!file) throw notFound('Reference file not found');
  await prisma.referenceFile.delete({ where: { id } });
  return { removed: true };
}

/**
 * Domain readiness = share of that domain's inputs which are filled *and* verified. Scored over
 * every field in the domain, not just the required ones, for the same reason as overall input
 * readiness: only two fields are required, and most domains contain neither of them.
 */
export async function recomputeDomainReadiness(projectId: string) {
  const values = await prisma.projectInputValue.findMany({ where: { projectId }, include: { definition: true } });
  const domains: ManagementDomain[] = ['GOVERNANCE', 'SCOPE', 'SCHEDULE', 'FINANCE', 'STAKEHOLDERS', 'RESOURCES', 'RISK'];

  for (const domain of domains) {
    const scoped = values.filter((value) => value.definition.domain === domain);
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
