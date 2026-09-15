/**
 * Re-seeds the document catalog only — `DocumentDefinition` rows and their templates.
 *
 *   npm run db:seed:catalog
 *
 * Adding a document to `data/document-catalog.ts` has no effect on a database that was seeded
 * before it existed, and the full seed refuses to run twice (and would recreate demo projects if
 * it did). This is the safe way to land a catalog change on a database that already has real
 * projects: every write is an upsert, and nothing outside `DocumentDefinition` is touched.
 *
 * Projects that already froze a document pack pick the new document up through
 * `syncDocumentsWithPack`, which runs whenever the studio catalog is read.
 */

import 'dotenv/config';
import { ManagementDomain, PrismaClient, ProjectType } from '@prisma/client';
import { DOCUMENT_CATALOG } from '../src/data/document-catalog';
import { seedDocumentCatalog } from './seed';

const prisma = new PrismaClient();

/** `projectType|domain|name` for everything the catalog currently declares. */
function catalogKeys(): Set<string> {
  const keys = new Set<string>();
  for (const [type, domains] of Object.entries(DOCUMENT_CATALOG)) {
    for (const [domain, entries] of Object.entries(domains)) {
      for (const entry of entries) keys.add(`${type}|${domain}|${entry.name}`);
    }
  }
  return keys;
}

/**
 * Removes definitions the catalog no longer declares.
 *
 * `seedDocumentCatalog` only ever upserts, so a document removed from the catalog — or moved to a
 * different domain — would otherwise linger in the studio forever. Deleting a definition cascades
 * its generated `PlanningDocument`s, so anything a PM has actually generated is reported and left
 * alone unless `--force` is passed: silently destroying someone's approved draft to tidy a list is
 * not a trade this script gets to make on its own.
 */
async function prune(force: boolean) {
  const keep = catalogKeys();
  let all = await prisma.documentDefinition.findMany({
    include: { _count: { select: { documents: true } } },
  });
  let stale = all.filter((d) => !keep.has(`${d.projectType}|${d.domain}|${d.name}`));

  // A document that only *moved domain* is not a removal, so its drafts must move with it rather
  // than be destroyed. Re-point them at the live definition, then the old row is safe to delete.
  const live = new Map(all.filter((d) => keep.has(`${d.projectType}|${d.domain}|${d.name}`))
    .map((d) => [`${d.projectType}|${d.name}`, d]));

  let moved = 0;
  for (const old of stale) {
    const target = live.get(`${old.projectType}|${old.name}`);
    if (!target) continue;
    const documents = await prisma.planningDocument.findMany({ where: { definitionId: old.id } });
    for (const document of documents) {
      // (projectId, definitionId) is unique: if the project somehow already has one on the new
      // definition, leave the old draft where it is rather than losing either.
      const clash = await prisma.planningDocument.findUnique({
        where: { projectId_definitionId: { projectId: document.projectId, definitionId: target.id } },
      });
      if (clash) continue;
      await prisma.planningDocument.update({
        where: { id: document.id },
        data: { definitionId: target.id, domain: target.domain },
      });
      moved += 1;
    }
  }
  if (moved) console.log(`\nmoved ${moved} generated document(s) onto their definition's new domain`);

  // Re-read: the moves changed what is stale.
  all = await prisma.documentDefinition.findMany({ include: { _count: { select: { documents: true } } } });
  stale = all.filter((d) => !keep.has(`${d.projectType}|${d.domain}|${d.name}`));

  if (!stale.length) {
    console.log('\nnothing stale — every definition is still in the catalog');
    return;
  }

  /**
   * What counts as "someone's work" is a document that has actually been *written*.
   * `syncDocumentsWithPack` provisions a `NOT_GENERATED` row for every catalog document the moment
   * a governance model is confirmed, so counting rows would treat a document nobody has touched as
   * precious and refuse to ever remove it.
   */
  const written = new Map<string, number>();
  for (const d of stale) {
    written.set(
      d.id,
      await prisma.planningDocument.count({
        where: { definitionId: d.id, status: { not: 'NOT_GENERATED' } },
      }),
    );
  }

  const empty = stale.filter((d) => (written.get(d.id) ?? 0) === 0);
  const used = stale.filter((d) => (written.get(d.id) ?? 0) > 0);

  console.log(`\nstale definitions: ${stale.length}`);
  for (const d of stale) {
    const count = written.get(d.id) ?? 0;
    const placeholders = d._count.documents - count;
    const note = count
      ? `${count} written draft(s) — kept`
      : `never written${placeholders ? ` (${placeholders} empty placeholder row(s))` : ''}`;
    console.log(`  ${d.projectType.padEnd(8)} ${d.domain.padEnd(14)} ${d.name.padEnd(34)} ${note}`);
  }

  const toDelete = force ? stale : empty;
  if (toDelete.length) {
    const ids = toDelete.map((d) => d.id);
    // `PlanningDocument.definitionId` has no cascade, so its rows have to go first. For an `empty`
    // definition these are only the placeholders `syncDocumentsWithPack` provisioned; with
    // `--force` they are real drafts, which is exactly what --force is consenting to.
    const [documents] = await prisma.$transaction([
      prisma.planningDocument.deleteMany({ where: { definitionId: { in: ids } } }),
      prisma.documentTemplate.deleteMany({ where: { definitionId: { in: ids } } }),
      prisma.documentDefinition.deleteMany({ where: { id: { in: ids } } }),
    ]);
    console.log(`\nremoved ${toDelete.length} definition(s) and ${documents.count} document row(s)`);
  }
  if (used.length && !force) {
    console.log(
      `\nkept ${used.length} definition(s) with drafts someone has actually written. ` +
        'Re-run with --force to remove them and those drafts.',
    );
  }
}

async function main() {
  const force = process.argv.includes('--force');

  const before = await prisma.documentDefinition.count();
  await seedDocumentCatalog();
  await prune(force);
  const after = await prisma.documentDefinition.count();
  console.log(`\ndocument definitions: ${before} → ${after}`);

  console.log('\ncatalog per project type:');
  for (const type of Object.keys(DOCUMENT_CATALOG) as ProjectType[]) {
    const rows = await prisma.documentDefinition.groupBy({
      by: ['domain'],
      where: { projectType: type },
      _count: true,
    });
    const byDomain = new Map(rows.map((r) => [r.domain, r._count]));
    const parts = (Object.keys(DOCUMENT_CATALOG[type]) as ManagementDomain[])
      .map((domain) => `${domain} ${byDomain.get(domain) ?? 0}`)
      .join(' · ');
    const total = rows.reduce((sum, r) => sum + r._count, 0);
    console.log(`  ${type.padEnd(8)} ${String(total).padStart(2)} documents   ${parts}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
