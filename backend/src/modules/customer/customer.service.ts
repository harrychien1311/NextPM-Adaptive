/**
 * The customer reference library: each customer's own checklists and document templates, uploaded
 * once and reused by every project for that customer.
 *
 * This exists so a PM never re-uploads the same LGCNS or SKAX checklist into each new workspace.
 * A project finds its customer by matching the free-text `Project.customer` field against
 * `Customer.aliases` (`lib/customer-match.ts`) — the field stays free text so a project for a new
 * customer can start before anyone has curated a list.
 *
 * Nothing here is retrieved by similarity. A checklist is fetched by customer and a template by
 * (customer, documentType): key lookups, not nearest-neighbour search. Adding more templates adds
 * rows, not a retrieval problem — which is why there is no vector store.
 *
 * Parsing is deliberately separated from storing. The original file is always kept, whatever the
 * parser managed to read, and `parseNote` records what it did. A file the parser could not
 * understand is still uploaded and still visible, flagged — never silently dropped.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Prisma, type CustomerReferenceKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, notFound } from '../../lib/http-error';
import { env } from '../../config/env';
import { parseChecklist } from '../../lib/checklist-parser';
import { extractTextFromFile } from '../../lib/extract-text';
import { parseTemplate } from '../../lib/pptx-template';
import { matchCustomer } from '../../lib/customer-match';
import { translateChecklistItems } from '../ai/provider';
import { logEvent } from '../audit/audit.service';

/** `key` is what code refers to, so it must stay a stable, boring slug. */
function toKey(value: string): string {
  return value
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 24);
}

const filePath = (storageKey: string) => path.join(env.uploadDir, storageKey);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function listCustomers() {
  const customers = await prisma.customer.findMany({
    orderBy: { name: 'asc' },
    include: {
      checklists: {
        orderBy: [{ active: 'desc' }, { version: 'desc' }],
        include: { _count: { select: { items: true } } },
      },
      templates: { orderBy: [{ active: 'desc' }, { version: 'desc' }] },
      references: { orderBy: { uploadedAt: 'desc' } },
    },
  });

  return customers.map(({ references, ...customer }) => ({
    ...customer,
    hasLogo: Boolean(customer.logoStorageKey),
    checklists: customer.checklists.map(({ _count, storageKey, ...checklist }) => ({
      ...checklist,
      itemCount: _count.items,
    })),
    templates: customer.templates.map(({ storageKey, placeholders, outline, ...template }) => ({
      ...template,
      placeholders,
      placeholderCount: Array.isArray(placeholders) ? placeholders.length : 0,
      /** Null for a template uploaded before outlines were recorded — read on first use. */
      outline: Array.isArray(outline) ? outline : null,
    })),
    references: references.map(({ storageKey, extraction, ...reference }) => ({
      ...reference,
      textAvailable: Boolean((extraction as { textAvailable?: boolean } | null)?.textAvailable),
    })),
  }));
}

/**
 * Every document name the app can generate — the choices for a template's document type.
 *
 * Templates are matched to documents by name, so a free-text type spelled differently from the
 * catalog is a template that never gets used, silently. Offering the catalog's own spellings makes
 * the match exact; "Other" stays available for a document the catalog does not have yet. Extended
 * definitions (added by the Planning Assessment) are included — they are generated like any other.
 */
export async function listDocumentTypes() {
  const definitions = await prisma.documentDefinition.findMany({
    select: { name: true, projectType: true },
    orderBy: { name: 'asc' },
  });
  const byName = new Map<string, Set<string>>();
  for (const definition of definitions) {
    if (!byName.has(definition.name)) byName.set(definition.name, new Set());
    byName.get(definition.name)!.add(definition.projectType);
  }
  return [...byName.entries()]
    .map(([name, types]) => ({ name, projectTypes: [...types].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createCustomer(params: { key?: string; name: string; aliases?: string[]; actorId: string }) {
  const key = toKey(params.key || params.name);
  if (!key) throw badRequest('Customer name must contain at least one letter or digit');

  const existing = await prisma.customer.findUnique({ where: { key } });
  if (existing) throw conflict(`A customer with key ${key} already exists`);

  const customer = await prisma.customer.create({
    data: { key, name: params.name.trim(), aliases: normalizeAliases(params.aliases, params.name, key) },
  });

  await logEvent({
    actorId: params.actorId,
    actorType: 'PM',
    type: 'CUSTOMER_CREATED',
    title: `Customer ${customer.name} added to the reference library`,
    detail: `key ${customer.key} · aliases: ${customer.aliases.join(', ') || 'none'}`,
    payload: { customerId: customer.id },
  });

  return customer;
}

export async function updateCustomer(
  customerId: string,
  params: { name?: string; aliases?: string[]; active?: boolean },
) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw notFound('Customer not found');

  return prisma.customer.update({
    where: { id: customerId },
    data: {
      name: params.name?.trim() ?? undefined,
      aliases: params.aliases ? normalizeAliases(params.aliases, params.name ?? customer.name, customer.key) : undefined,
      active: params.active ?? undefined,
    },
  });
}

export async function deleteCustomer(customerId: string) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { checklists: true, templates: true, references: true },
  });
  if (!customer) throw notFound('Customer not found');

  // Cascade deletes the rows; the stored files have to be removed by hand.
  const keys = [
    ...customer.checklists.map((c) => c.storageKey),
    ...customer.templates.map((t) => t.storageKey),
    ...customer.references.map((r) => r.storageKey),
    ...(customer.logoStorageKey ? [customer.logoStorageKey] : []),
  ];
  await prisma.customer.delete({ where: { id: customerId } });
  await Promise.all(keys.map((key) => fs.rm(filePath(key), { force: true }).catch(() => undefined)));

  return { deleted: true, checklists: customer.checklists.length, templates: customer.templates.length };
}

/**
 * Duplicates and blanks are noise — the matcher already tries the key and the name.
 *
 * Rule aliases are kept verbatim and de-duplicated on their own text: `*` (the house default) has
 * no alphanumeric fingerprint at all, and `SK*` must stay distinct from a plain `SK`. Fingerprint
 * de-duplication silently ate the `*` on its first run, which left the library with no default.
 */
function normalizeAliases(aliases: string[] | undefined, name: string, key: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases ?? []) {
    const trimmed = alias.trim();
    if (!trimmed) continue;

    const isRule = trimmed === '*' || (trimmed.length > 1 && trimmed.endsWith('*'));
    const fingerprint = isRule
      ? `rule:${trimmed.toLowerCase()}`
      : trimmed.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '');

    if (!fingerprint || fingerprint === 'rule:' || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(trimmed);
  }
  void name;
  void key;
  return out;
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export async function addChecklist(params: {
  customerId: string;
  name: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  actorId: string;
}) {
  const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
  if (!customer) throw notFound('Customer not found');

  const buffer = await fs.readFile(filePath(params.storageKey));
  const parsed = await parseChecklist(buffer, params.fileName);

  // A new upload supersedes the previous one rather than replacing it: a project already assessed
  // against v1 has to stay explainable after v2 lands.
  const previous = await prisma.customerChecklist.findFirst({
    where: { customerId: params.customerId },
    orderBy: { version: 'desc' },
  });

  const checklist = await prisma.$transaction(async (tx) => {
    await tx.customerChecklist.updateMany({ where: { customerId: params.customerId }, data: { active: false } });
    return tx.customerChecklist.create({
      data: {
        customerId: params.customerId,
        name: params.name.trim() || params.fileName,
        sourceFile: params.fileName,
        storageKey: params.storageKey,
        mimeType: params.mimeType,
        version: (previous?.version ?? 0) + 1,
        active: true,
        parseNote: parsed.note,
        items: { create: parsed.items },
      },
      include: { _count: { select: { items: true } } },
    });
  });

  await translateChecklist(checklist.id);

  await logEvent({
    actorId: params.actorId,
    actorType: 'PM',
    type: 'CUSTOMER_CHECKLIST_UPLOADED',
    title: `Checklist v${checklist.version} uploaded for ${customer.name}`,
    detail: parsed.note,
    payload: { customerId: customer.id, checklistId: checklist.id, items: parsed.items.length },
  });

  return { ...checklist, itemCount: checklist._count.items, parsed: parsed.note };
}

/**
 * Writes the English reading of every item of one checklist.
 *
 * Separate from the upload transaction on purpose: the model call is slow and can fail, and an
 * uploaded checklist must land whether or not it could be translated. Items already in English
 * come back untranslated and simply keep a null `textEn`, which the UI reads as "there is only one
 * version of this line".
 *
 * Exported so a checklist uploaded before this existed, or one whose translation failed, can be
 * filled in later without re-uploading the file.
 */
export async function translateChecklist(checklistId: string) {
  const items = await prisma.checklistItem.findMany({
    where: { checklistId },
    orderBy: { order: 'asc' },
    select: { id: true, text: true, section: true, guidance: true },
  });
  if (!items.length) return { translated: 0, total: 0 };

  const translations = await translateChecklistItems(items);
  let written = 0;
  for (const translation of translations) {
    const data = {
      ...(translation.textEn?.trim() ? { textEn: translation.textEn.trim() } : {}),
      ...(translation.sectionEn?.trim() ? { sectionEn: translation.sectionEn.trim() } : {}),
      ...(translation.guidanceEn?.trim() ? { guidanceEn: translation.guidanceEn.trim() } : {}),
    };
    if (!Object.keys(data).length) continue;
    // An id the model invented updates nothing; `updateMany` scoped to this checklist makes that
    // a no-op instead of an error that would fail the whole upload.
    const result = await prisma.checklistItem.updateMany({ where: { id: translation.id, checklistId }, data });
    written += result.count;
  }
  return { translated: written, total: items.length };
}

export async function checklistItems(checklistId: string) {
  const checklist = await prisma.customerChecklist.findUnique({
    where: { id: checklistId },
    include: { customer: { select: { id: true, key: true, name: true } }, items: { orderBy: { order: 'asc' } } },
  });
  if (!checklist) throw notFound('Checklist not found');
  const { storageKey, ...rest } = checklist;
  return rest;
}

export async function deleteChecklist(checklistId: string) {
  const checklist = await prisma.customerChecklist.findUnique({ where: { id: checklistId } });
  if (!checklist) throw notFound('Checklist not found');
  await prisma.customerChecklist.delete({ where: { id: checklistId } });
  await fs.rm(filePath(checklist.storageKey), { force: true }).catch(() => undefined);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function addTemplate(params: {
  customerId: string;
  documentType: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
  actorId: string;
}) {
  const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
  if (!customer) throw notFound('Customer not found');

  const documentType = params.documentType.trim();
  if (!documentType) throw badRequest('Say which document this template is for');

  const buffer = await fs.readFile(filePath(params.storageKey));
  const parsed = await parseTemplate(buffer, params.fileName);

  const previous = await prisma.customerTemplate.findFirst({
    where: { customerId: params.customerId, documentType },
    orderBy: { version: 'desc' },
  });

  const template = await prisma.$transaction(async (tx) => {
    await tx.customerTemplate.updateMany({
      where: { customerId: params.customerId, documentType },
      data: { active: false },
    });
    return tx.customerTemplate.create({
      data: {
        customerId: params.customerId,
        documentType,
        fileType: parsed.fileType,
        sourceFile: params.fileName,
        storageKey: params.storageKey,
        mimeType: params.mimeType,
        version: (previous?.version ?? 0) + 1,
        active: true,
        placeholders: parsed.placeholders as unknown as Prisma.InputJsonValue,
        outline: parsed.outline as unknown as Prisma.InputJsonValue,
        parseNote: parsed.note,
      },
    });
  });

  await logEvent({
    actorId: params.actorId,
    actorType: 'PM',
    type: 'CUSTOMER_TEMPLATE_UPLOADED',
    title: `${documentType} template v${template.version} uploaded for ${customer.name}`,
    detail: parsed.note,
    payload: { customerId: customer.id, templateId: template.id, placeholders: parsed.placeholders.length },
  });

  const { storageKey, ...rest } = template;
  return rest;
}

export async function deleteTemplate(templateId: string) {
  const template = await prisma.customerTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw notFound('Template not found');
  await prisma.customerTemplate.delete({ where: { id: templateId } });
  await fs.rm(filePath(template.storageKey), { force: true }).catch(() => undefined);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Approved examples and lessons learned
// ---------------------------------------------------------------------------

/**
 * Stores a document on a library's Approved Examples or Lessons Learned tab.
 *
 * Kept with its extracted text so a later feature can read it without a re-upload; nothing in
 * generation or assessment reads these yet, and the screen says so. Unlike checklists and
 * templates these are not versioned — each upload is its own document.
 */
export async function addReference(params: {
  customerId: string;
  kind: CustomerReferenceKind;
  title?: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  actorId: string;
}) {
  const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
  if (!customer) throw notFound('Customer not found');

  const { text } = await extractTextFromFile({ storageKey: params.storageKey, fileName: params.fileName });
  const reference = await prisma.customerReference.create({
    data: {
      customerId: params.customerId,
      kind: params.kind,
      title: params.title?.trim() || params.fileName.replace(/\.[^.]+$/, ''),
      sourceFile: params.fileName,
      storageKey: params.storageKey,
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      extraction: { rawText: text, textAvailable: Boolean(text) },
      uploadedById: params.actorId,
    },
  });

  await logEvent({
    actorId: params.actorId,
    actorType: 'PM',
    type: 'CUSTOMER_REFERENCE_UPLOADED',
    title: `${params.kind === 'APPROVED_EXAMPLE' ? 'Approved example' : 'Lesson learned'} "${reference.title}" added to ${customer.name}`,
    detail: text ? 'Text extracted.' : 'Stored, but no readable text was found.',
    payload: { customerId: customer.id, referenceId: reference.id, kind: params.kind },
  });

  const { storageKey, extraction, ...rest } = reference;
  return { ...rest, textAvailable: Boolean(text) };
}

export async function deleteReference(referenceId: string) {
  const reference = await prisma.customerReference.findUnique({ where: { id: referenceId } });
  if (!reference) throw notFound('Document not found');
  await prisma.customerReference.delete({ where: { id: referenceId } });
  await fs.rm(filePath(reference.storageKey), { force: true }).catch(() => undefined);
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

export async function setLogo(params: {
  customerId: string;
  fileName: string;
  mimeType: string;
  storageKey: string;
}) {
  const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
  if (!customer) throw notFound('Customer not found');

  const updated = await prisma.customer.update({
    where: { id: params.customerId },
    data: { logoStorageKey: params.storageKey, logoFileName: params.fileName, logoMimeType: params.mimeType },
  });
  if (customer.logoStorageKey) await fs.rm(filePath(customer.logoStorageKey), { force: true }).catch(() => undefined);
  return { ...updated, hasLogo: true };
}

/**
 * Resolves a stored file to something the routes can stream.
 *
 * The row and the file on disk can disagree — uploads live in a Docker volume, so a database
 * restored or seeded from elsewhere will reference files this container cannot see. That is worth
 * saying plainly instead of letting `sendFile` fail with an opaque error.
 */
export async function customerFile(
  kind: 'checklist' | 'template' | 'logo' | 'reference',
  id: string,
): Promise<{ path: string; fileName: string; mimeType: string }> {
  const resolved = await (async () => {
    if (kind === 'reference') {
      const row = await prisma.customerReference.findUnique({ where: { id } });
      if (!row) throw notFound('Document not found');
      return { path: filePath(row.storageKey), fileName: row.sourceFile, mimeType: row.mimeType };
    }
    if (kind === 'checklist') {
      const row = await prisma.customerChecklist.findUnique({ where: { id } });
      if (!row) throw notFound('Checklist not found');
      return { path: filePath(row.storageKey), fileName: row.sourceFile, mimeType: row.mimeType };
    }
    if (kind === 'template') {
      const row = await prisma.customerTemplate.findUnique({ where: { id } });
      if (!row) throw notFound('Template not found');
      return { path: filePath(row.storageKey), fileName: row.sourceFile, mimeType: row.mimeType };
    }
    const row = await prisma.customer.findUnique({ where: { id } });
    if (!row?.logoStorageKey) throw notFound('This customer has no logo');
    return {
      path: filePath(row.logoStorageKey),
      fileName: row.logoFileName ?? 'logo',
      mimeType: row.logoMimeType ?? 'application/octet-stream',
    };
  })();

  try {
    await fs.access(resolved.path);
  } catch {
    throw notFound(
      `"${resolved.fileName}" is recorded in the library but its stored file is missing from ${env.uploadDir} — re-upload it.`,
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Matching a project's free-text customer name to the library
// ---------------------------------------------------------------------------

/**
 * What the library holds for a given typed-in customer name. Returns a *suggestion*, never an
 * applied decision — choosing the wrong customer would mean assessing against the wrong checklist
 * and filling the wrong company's template, so the PM confirms.
 */
export async function resolveCustomer(customerText: string | null | undefined) {
  const customers = await prisma.customer.findMany({
    where: { active: true },
    include: {
      checklists: { where: { active: true }, include: { _count: { select: { items: true } } } },
      templates: { where: { active: true } },
    },
  });

  const match = matchCustomer(customerText, customers);
  if (!match) {
    return {
      matched: false as const,
      typed: customerText ?? null,
      known: customers.map((customer) => ({ id: customer.id, key: customer.key, name: customer.name })),
    };
  }

  const { customer, confidence, matchedOn } = match;
  return {
    matched: true as const,
    typed: customerText ?? null,
    confidence,
    matchedOn,
    customer: {
      id: customer.id,
      key: customer.key,
      name: customer.name,
      hasLogo: Boolean(customer.logoStorageKey),
      checklist: customer.checklists[0]
        ? {
            id: customer.checklists[0].id,
            name: customer.checklists[0].name,
            version: customer.checklists[0].version,
            itemCount: customer.checklists[0]._count.items,
          }
        : null,
      templates: customer.templates.map((template) => ({
        id: template.id,
        documentType: template.documentType,
        fileType: template.fileType,
        version: template.version,
      })),
    },
  };
}
