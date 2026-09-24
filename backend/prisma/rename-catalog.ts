/**
 * Carries existing work across a catalog rename or merge, before `db:seed:catalog` runs.
 *
 *   npm run db:rename:catalog -- --dry   # report what would move, change nothing
 *   npm run db:rename:catalog            # apply, then run db:seed:catalog
 *
 * `seedDocumentCatalog` upserts on `(projectType, domain, name)`, so from its point of view a
 * renamed document is a new one and the old name is something to prune. Left alone that would strip
 * a project of drafts the PM had already generated and approved — the rename is a change of label,
 * not of subject, and nothing about the work stops being true because the heading moved.
 *
 * Two shapes, and the difference matters:
 *
 * - a plain **rename** keeps the definition row and only changes its `name`, so every
 *   `PlanningDocument` follows by foreign key with no copying at all;
 * - a **merge** (two old documents becoming one) cannot: the target already exists, so each draft
 *   is re-pointed at it and the empty loser is deleted. Where both sides hold a real draft the
 *   newest wins and the other is reported rather than silently dropped — two people's work arriving
 *   at one slot is a judgement call, not something a migration should make quietly.
 *
 * Safe to re-run: a mapping whose source no longer exists is skipped.
 */

import { DocumentStatus, ProjectType } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

const dryRun = process.argv.includes('--dry');

interface Move {
  type: ProjectType;
  from: string;
  to: string;
  why: string;
}

/**
 * Every name this review changed, with the reason, so the list reads as the record of the decision
 * rather than as a table of strings.
 */
const MOVES: Move[] = [
  // One log per project type, its `Type` column separating change / decision / assumption.
  { type: 'SI', from: 'Change & Decision Log', to: 'Decision Log', why: 'one governance log per type' },
  { type: 'PRODUCT', from: 'Decision & Assumption Log', to: 'Decision Log', why: 'one governance log per type' },

  // The escalation path is not the change-control process.
  { type: 'SI', from: 'Change / Escalation Flow', to: 'Issue Escalation Procedure', why: 'scope split from change control' },
  { type: 'SM', from: 'Change / Escalation Flow', to: 'Issue Escalation Procedure', why: 'scope split from change control' },
  { type: 'PRODUCT', from: 'Change / Escalation Flow', to: 'Issue Escalation Procedure', why: 'scope split from change control' },

  // PMI Lexicon, same name in all three types.
  { type: 'SI', from: 'Communication Plan', to: 'Communications Management Plan', why: 'PMI Lexicon' },
  { type: 'SM', from: 'Communication Plan', to: 'Communications Management Plan', why: 'PMI Lexicon' },
  { type: 'PRODUCT', from: 'Communication Plan', to: 'Communications Management Plan', why: 'PMI Lexicon' },
  { type: 'SM', from: 'Service Communication Plan', to: 'Communications Management Plan', why: 'merged — one comms plan' },

  { type: 'SM', from: 'Change Governance Plan', to: 'Change Management Plan', why: 'PMI Lexicon' },

  // One charter per project, and it is the Project Charter.
  { type: 'SM', from: 'Service Management Charter', to: 'Project Charter', why: 'merged — one charter' },
  { type: 'PRODUCT', from: 'Product Charter', to: 'Project Charter', why: 'merged — one charter' },
  { type: 'PRODUCT', from: 'Product Team Charter', to: 'Product Team Working Agreement', why: 'not a third charter' },

  // One RACI, matching SI and Product.
  { type: 'SM', from: 'Support Organization & RACI', to: 'RACI Matrix', why: 'merged — one RACI' },
];

const generated = (status: DocumentStatus) => status !== DocumentStatus.NOT_GENERATED;

async function main() {
  console.log(`${MOVES.length} mapping(s)${dryRun ? ' — dry run, nothing will be written' : ''}\n`);
  let renamed = 0;
  let merged = 0;
  let moved = 0;
  const conflicts: string[] = [];

  for (const move of MOVES) {
    const source = await prisma.documentDefinition.findFirst({
      where: { projectType: move.type, name: move.from },
      include: { documents: true },
    });
    if (!source) {
      console.log(`  —      ${move.type} "${move.from}" (already gone)`);
      continue;
    }

    // The target as the new catalog places it, which may be in another domain (SLA moved to
    // GOVERNANCE) — so match on name within the type, not on the source's own domain.
    const target = await prisma.documentDefinition.findFirst({
      where: { projectType: move.type, name: move.to },
      include: { documents: true },
    });

    if (!target) {
      // A plain rename. Every PlanningDocument follows the row, so nothing is copied.
      const withWork = source.documents.filter((doc) => generated(doc.status)).length;
      console.log(`  RENAME ${move.type} "${move.from}" → "${move.to}"  (${withWork} draft(s) carried) · ${move.why}`);
      if (!dryRun) {
        await prisma.documentDefinition.update({ where: { id: source.id }, data: { name: move.to } });
      }
      renamed += 1;
      continue;
    }

    // A merge. Re-point each project's draft at the surviving definition.
    let carried = 0;
    for (const document of source.documents) {
      const rival = target.documents.find((other) => other.projectId === document.projectId);
      if (!rival) {
        if (!dryRun) {
          await prisma.planningDocument.update({
            where: { id: document.id },
            data: { definitionId: target.id, name: move.to },
          });
        }
        carried += 1;
        continue;
      }
      // Both slots are filled for this project. An empty rival loses; two real drafts is a choice
      // somebody has to make, so it is reported and the older one is left where it is.
      if (!generated(rival.status) && generated(document.status)) {
        if (!dryRun) {
          await prisma.planningDocument.delete({ where: { id: rival.id } });
          await prisma.planningDocument.update({
            where: { id: document.id },
            data: { definitionId: target.id, name: move.to },
          });
        }
        carried += 1;
      } else if (generated(rival.status) && generated(document.status)) {
        conflicts.push(
          `${move.type} project ${document.projectId}: "${move.from}" (${document.status}) and ` +
            `"${move.to}" (${rival.status}) both have work — kept "${move.to}", the other is dropped with its definition`,
        );
      }
    }

    console.log(`  MERGE  ${move.type} "${move.from}" → "${move.to}"  (${carried} draft(s) carried) · ${move.why}`);
    if (!dryRun) {
      // Anything still hanging off the loser is an empty slot; delete it so the definition can go.
      await prisma.planningDocument.deleteMany({ where: { definitionId: source.id } });
      await prisma.documentTemplate.deleteMany({ where: { definitionId: source.id } });
      await prisma.documentDefinition.delete({ where: { id: source.id } });
    }
    merged += 1;
  }

  /**
   * A document that only changed domain keeps its name, so the loop above never sees it —
   * `seedDocumentCatalog` re-points those itself. Reported here only so the run accounts for it.
   */
  const slaMoved = await prisma.documentDefinition.findFirst({
    where: { projectType: 'SM', name: 'SLA / OLA Management Plan' },
  });
  if (slaMoved) {
    console.log(`  DOMAIN SM "SLA / OLA Management Plan" is in ${slaMoved.domain}; the catalog now puts it in GOVERNANCE`);
    moved += 1;
  }

  /**
   * `PlanningDocument.name` is a denormalised copy of its definition's name, and a plain rename
   * does not touch it — the row follows by foreign key, so the *link* is right while the label it
   * carries is the old one. Every screen reads that column, so without this step the Studio, the
   * dashboard library and the export file name would all still say "Change & Decision Log" over a
   * document the catalog now calls "Decision Log".
   *
   * The definition is the source of truth, so this reconciles rather than guesses.
   */
  const drifted = await prisma.$queryRaw<{ id: string; was: string; now: string }[]>`
    SELECT pd.id, pd.name AS was, dd.name AS now
      FROM planning_documents pd
      JOIN document_definitions dd ON dd.id = pd."definitionId"
     WHERE pd.name <> dd.name`;
  if (drifted.length) {
    console.log(`\n${drifted.length} document row(s) still carry the old label:`);
    for (const row of [...new Set(drifted.map((row) => `${row.was} → ${row.now}`))]) console.log(`  ${row}`);
    if (!dryRun) {
      await prisma.$executeRaw`
        UPDATE planning_documents pd
           SET name = dd.name
          FROM document_definitions dd
         WHERE dd.id = pd."definitionId" AND pd.name <> dd.name`;
      console.log('  relabelled to match their definition');
    }
  }

  console.log(`\n${renamed} renamed · ${merged} merged · ${moved} awaiting a domain move`);
  if (conflicts.length) {
    console.log(`\n${conflicts.length} project(s) had work on both sides of a merge:`);
    for (const line of conflicts) console.log(`  ! ${line}`);
  }
  console.log(dryRun ? '\nDry run — run without --dry, then `npm run db:seed:catalog`.' : '\nNow run `npm run db:seed:catalog`.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
