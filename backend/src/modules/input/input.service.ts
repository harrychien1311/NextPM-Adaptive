import path from 'node:path';
import { ActionPriority, InputSource, ManagementDomain, Prisma, ReferenceGroup, ReferenceStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/http-error';
import { env } from '../../config/env';
import { REFERENCE_GROUPS } from '../../data/input-schemas';
import { extractTextFromFile } from '../../lib/extract-text';
import { matchOptionsInText } from '../../lib/option-match';
import { computeInputReadiness } from '../../lib/readiness';
import { extractInputValues, type AiProvider, type PlanningGap } from '../ai/provider';
import { isRecognised, matchCustomer } from '../../lib/customer-match';
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
    /** What the customer library matches on. Free text, set only by the PM. */
    customer: project.customer,
    /** A name read from the documents, waiting for the PM to accept or dismiss it. */
    customerSuggestion: readCustomerSuggestion(project.customerSuggestion),
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
          verified: true,
        },
        /**
         * A value the PM typed is verified the moment they type it.
         *
         * It used to land unverified and wait for the "Verify input" button. That button is gone —
         * Project Input now has one action, *Analyze planning needs* — so nothing would ever promote
         * these, and input readiness would sit at half for a fully-filled form. The rule that
         * mattered is untouched: a *document* still never becomes an approved fact on its own. This
         * is the PM's own answer, and there is no second person to confirm it to.
         */
        update: { value: value.value, source: InputSource.PM_INPUT, verified: true, conflictNote: null },
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
/**
 * A customer name Skill 0 read out of the documents, waiting for the PM to accept or dismiss it.
 *
 * It is stored on the project rather than applied, for the same reason every other extraction in
 * this system is a candidate: a wrong customer means the project is scored against the wrong
 * customer's checklist and another company's template gets filled with it.
 */
export interface CustomerSuggestion {
  /** The name exactly as the document writes it. */
  name: string;
  /** A verbatim quote from the document, so the PM can judge it without opening the file. */
  evidence: string;
  /** Which uploaded file it came from. */
  sourceLabel: string | null;
  /** The reference-library customer this name resolves to, when it resolves to one. */
  matchedKey: string | null;
  matchedName: string | null;
  /**
   * What the Customer field said when this was proposed, when it said anything. Accepting would
   * replace it, so the PM has to be shown what they are replacing — a proposal that quietly
   * overwrites a value someone typed is not a proposal.
   */
  replaces: string | null;
  suggestedAt: string;
}

/** Attaches the library match and the source file to what the model returned. */
export async function buildCustomerSuggestion(
  proposed: { name: string; evidence: string },
  documents: { label: string; text: string }[],
  replaces: string | null,
): Promise<CustomerSuggestion> {
  const customers = await prisma.customer.findMany({ where: { active: true } });
  // Only a *recognised* customer is worth reporting here. The house default claims every
  // unrecognised name, and telling the PM "this matches FPT" would make the banner look like it
  // had identified their customer when all it did was fall back.
  const candidate = matchCustomer(proposed.name, customers);
  const match = isRecognised(candidate) ? candidate : null;

  // Name the file the quote came from, so the PM knows where to look. Falls back to null rather
  // than to a guess when the quote cannot be located.
  const source = documents.find((document) => document.text.includes(proposed.evidence)) ?? null;

  return {
    name: proposed.name,
    evidence: proposed.evidence,
    sourceLabel: source?.label ?? null,
    matchedKey: match?.customer.key ?? null,
    matchedName: match?.customer.name ?? null,
    replaces: replaces?.trim() || null,
    suggestedAt: new Date().toISOString(),
  };
}

/** Normalises the JSON column back into a suggestion, or null. */
export function readCustomerSuggestion(value: unknown): CustomerSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<CustomerSuggestion>;
  if (!record.name || !record.evidence) return null;
  return {
    name: record.name,
    evidence: record.evidence,
    sourceLabel: record.sourceLabel ?? null,
    matchedKey: record.matchedKey ?? null,
    matchedName: record.matchedName ?? null,
    replaces: record.replaces ?? null,
    suggestedAt: record.suggestedAt ?? new Date().toISOString(),
  };
}

/**
 * The PM's decision on a proposed customer. Accepting writes `Project.customer` — which is what
 * unlocks the customer's checklist and templates — and clears the suggestion either way.
 */
export async function resolveCustomerSuggestion(params: {
  projectId: string;
  action: 'accept' | 'dismiss';
  /** The PM may correct the name before accepting it. */
  value?: string | null;
  actorId: string;
}) {
  const project = await prisma.project.findUnique({ where: { id: params.projectId } });
  if (!project) throw notFound('Project not found');

  const suggestion = readCustomerSuggestion(project.customerSuggestion);

  if (params.action === 'dismiss') {
    await prisma.project.update({ where: { id: params.projectId }, data: { customerSuggestion: Prisma.JsonNull } });
    await logEvent({
      projectId: params.projectId,
      actorId: params.actorId,
      actorType: 'PM',
      type: 'CUSTOMER_SUGGESTION_DISMISSED',
      title: `PM dismissed the proposed customer${suggestion ? ` "${suggestion.name}"` : ''}`,
      detail: suggestion?.evidence ?? null,
    });
    return { customer: project.customer, suggestion: null };
  }

  const customer = (params.value ?? suggestion?.name ?? '').trim();
  if (!customer) throw badRequest('There is no customer name to confirm.');

  const updated = await prisma.project.update({
    where: { id: params.projectId },
    data: { customer, customerSuggestion: Prisma.JsonNull },
  });

  await logEvent({
    projectId: params.projectId,
    actorId: params.actorId,
    actorType: 'PM',
    type: 'CUSTOMER_CONFIRMED',
    title: `PM confirmed the customer as "${customer}"`,
    detail: suggestion
      ? `Proposed from ${suggestion.sourceLabel ?? 'an uploaded document'}: "${suggestion.evidence}"`
      : 'Entered by the PM.',
    payload: { customer, proposed: suggestion?.name ?? null },
  });

  return { customer: updated.customer, suggestion: null };
}

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
  let customerSuggestion: CustomerSuggestion | null = null;

  // The customer is identified from the same read of the same documents — no extra call. It runs
  // whenever there are documents, even if every field is already filled, because a project can
  // have a complete form and still no customer set.
  if (documents.length) {
    const corpus = documents.map((document) => document.text).join('\n\n');

    // Stage 1 — deterministic, free, no tokens spent.
    const matched = matchOptionsInText(
      corpus,
      emptyDefinitions.map((definition) => ({ fieldKey: definition.key, options: definition.options })),
    );
    for (const match of matched) suggestions.set(match.fieldKey, match.value);

    // Stage 2 — the model, for everything stage 1 could not resolve (including any document
    // that is not in English, where literal option matching can never work), and the customer.
    const unresolved = emptyDefinitions.filter((definition) => !suggestions.has(definition.key));

    /**
     * Propose a customer when the project has none, and *also* when the one it has resolves to
     * nothing in the reference library.
     *
     * The second case is the one that actually matters in practice: a project whose customer reads
     * "Korea — Enterprise" (what the demo seed writes) or a business-unit name looks filled in but
     * unlocks no checklist and no template, and the PM has no way to know that is why nothing
     * applied. Proposing a name the documents support — with its quote, for them to accept or
     * reject — is exactly the help they need there. It still never overwrites anything: a project
     * whose customer already resolves to a library entry is left alone.
     */
    // `isRecognised`, not a null check: the library has a house-default customer that claims
    // anything unrecognised, so a plain match now always succeeds. Treating that as "we know who
    // the customer is" would silence this proposal on exactly the projects that need it.
    const currentCustomerResolves = project.customer
      ? isRecognised(matchCustomer(project.customer, await prisma.customer.findMany({ where: { active: true } })))
      : false;
    const needsCustomer = !currentCustomerResolves;

    if (unresolved.length || needsCustomer) {
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

      // Proposing only. Nothing is written to `project.customer` here — see
      // resolveCustomerSuggestion, which is the PM's click. A proposal identical to what the
      // project already says is dropped: there would be nothing for the PM to decide.
      if (needsCustomer && extracted.customer) {
        const isSameAsCurrent =
          project.customer &&
          project.customer.trim().toLowerCase() === extracted.customer.name.trim().toLowerCase();
        if (!isSameAsCurrent) {
          customerSuggestion = await buildCustomerSuggestion(extracted.customer, documents, project.customer);
        }
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

  // Stored, not applied. The PM confirms it through resolveCustomerSuggestion.
  if (customerSuggestion) {
    await prisma.project.update({
      where: { id: projectId },
      data: { customerSuggestion: customerSuggestion as unknown as Prisma.InputJsonValue },
    });
  }

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
      ? `Read ${documents.length} uploaded document(s); extraction produced by ${provider}.` +
        (customerSuggestion
          ? ` Proposed "${customerSuggestion.name}" as the customer, awaiting PM confirmation.`
          : '')
      : 'No uploaded documents to read — verified the PM-entered profile only.',
  });

  return {
    verified: verifiable.length,
    prefilled: suggestions.size,
    documentsRead: documents.length,
    stillEmpty: definitions.length - (existingValues.filter((value) => value.value).length + suggestions.size),
    provider,
    /** A proposal for the PM to accept or dismiss — never applied by this call. */
    customerSuggestion,
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

/** A gap's severity, in the three priorities the action center already draws and colours. */
const GAP_PRIORITY: Record<PlanningGap['severity'], ActionPriority> = {
  HIGH: ActionPriority.REQUIRED,
  MEDIUM: ActionPriority.CONDITIONAL,
  LOW: ActionPriority.INFO,
};

/**
 * Rebuilds the PM action center from the planning gaps the analysis just found.
 *
 * Nothing in the app created an `ActionItem` before this, so the panel was permanently empty on
 * every project and `resolveAction` below had nothing to resolve. The gaps are the natural source:
 * they are already "what this project still lacks", judged against the uploaded documents rather
 * than against a generic checklist of good practice.
 *
 * Three rules worth keeping:
 *
 * - **Re-running the analysis replaces the OPEN set**, because those entries describe a snapshot
 *   that has just been superseded. RESOLVED and DISMISSED rows are left alone as history. A gap the
 *   PM already resolved that the new analysis still reports therefore comes back — the new read
 *   still says it is missing, and swallowing that silently is the one failure nobody could see.
 * - **`blocksDocument` stays null, and the delete is scoped to rows where it already is.** A gap
 *   says a document is missing; setting it here would, at REQUIRED priority, make `generateDraft`
 *   refuse to generate the very document that closes the gap — it checks exactly that pair. Scoping
 *   the delete means a hand-created blocker is never swept away by an analysis run either.
 * - **The domain comes from the catalog entry the gap names, never from the model.** The model is
 *   not asked for one, and a guessed domain files the entry under the wrong heading.
 */
export async function syncPlanningActions(projectId: string, gaps: PlanningGap[]) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { type: true } });
  if (!project) throw notFound('Project not found');

  const definitions = await prisma.documentDefinition.findMany({
    where: { projectType: project.type },
    select: { name: true, domain: true },
  });
  const domainByDocument = new Map(definitions.map((definition) => [definition.name.trim().toLowerCase(), definition.domain]));

  await prisma.actionItem.deleteMany({ where: { projectId, status: 'OPEN', blocksDocument: null } });
  if (!gaps.length) return 0;

  const { count } = await prisma.actionItem.createMany({
    data: gaps.map((gap) => {
      const domain = gap.documentName ? domainByDocument.get(gap.documentName.trim().toLowerCase()) : undefined;
      return {
        projectId,
        priority: GAP_PRIORITY[gap.severity] ?? ActionPriority.CONDITIONAL,
        domain: domain ?? ManagementDomain.GOVERNANCE,
        title: gap.title,
        description: gap.why,
        /**
         * The Studio only when the gap names a document the catalog actually holds — its gap filter
         * keys on that name, so sending the PM there for an unmatched one lands them on a filter
         * that hides everything. Anything else is a hole in the project profile: Input.
         */
        targetView: domain ? 'studio' : 'input',
        suggestions: gap.documentName ? [gap.documentName] : [],
      };
    }),
  });
  return count;
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

  /**
   * A file whose text could not be read is a failed upload, not a reference source: it can never
   * prefill or verify anything, and leaving it in place means its "cannot be read" message stays on
   * screen after the PM has already replaced it — which is what the button labelled *Replace*
   * promised to do. It also occupies one of the group's two slots for nothing. So the moment a new
   * file arrives for this group, the group's unreadable ones are cleared.
   *
   * Only the unreadable ones. A group is allowed two real sources, and silently deleting a readable
   * file the PM uploaded on purpose would lose their work.
   */
  const inGroup = await prisma.referenceFile.findMany({
    where: { projectId: params.projectId, group: params.group },
  });
  const unreadable = inGroup.filter((file) => !(file.extraction as { textAvailable?: boolean } | null)?.textAvailable);
  if (unreadable.length) {
    await prisma.referenceFile.deleteMany({ where: { id: { in: unreadable.map((file) => file.id) } } });
  }

  if (inGroup.length - unreadable.length >= env.maxFilesPerGroup) {
    throw badRequest(
      `Maximum ${env.maxFilesPerGroup} files per reference group — remove one before adding another`,
    );
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

/**
 * One uploaded file for the preview panel: its metadata plus the text extracted on upload.
 * The original bytes stay on disk — `referenceFilePath` below serves those for download.
 */
export async function referenceDetail(projectId: string, id: string) {
  const file = await prisma.referenceFile.findFirst({ where: { id, projectId } });
  if (!file) throw notFound('Reference file not found');
  const extraction = file.extraction as { rawText?: string; textAvailable?: boolean } | null;

  return {
    id: file.id,
    fileName: file.fileName,
    group: file.group,
    status: file.status,
    message: file.message,
    sizeBytes: file.sizeBytes,
    uploadedAt: file.uploadedAt,
    textAvailable: Boolean(extraction?.textAvailable),
    text: extraction?.textAvailable ? (extraction.rawText ?? null) : null,
  };
}

/** Resolves the on-disk path of an upload, for streaming the original file back. */
export async function referenceFilePath(projectId: string, id: string) {
  const file = await prisma.referenceFile.findFirst({ where: { id, projectId } });
  if (!file) throw notFound('Reference file not found');
  return { path: path.join(env.uploadDir, file.storageKey), fileName: file.fileName, mimeType: file.mimeType };
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
