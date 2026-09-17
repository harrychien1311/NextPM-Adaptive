/**
 * Fills the PM action center for projects whose analysis predates it.
 *
 * `syncPlanningActions` runs inside `runPlanningAnalysis`, so a project only gets action items the
 * next time someone presses *Analyze planning needs*. Every project analysed before that existed
 * therefore shows an empty panel while its gaps sit, unchanged, in the `AiApproachSuggestion`
 * snapshot the analysis already stored. This reads the latest snapshot per project and writes the
 * actions from it.
 *
 *   npm run db:backfill:actions            # write them
 *   npm run db:backfill:actions -- --dry   # report only, no write
 *
 * **Costs nothing.** It re-reads a stored answer rather than asking for a new one — there is no
 * model call here, which is the whole reason to prefer it over telling a PM to re-run the analysis
 * on every project.
 *
 * Safe to re-run: `syncPlanningActions` replaces the OPEN set each time, so a second pass is a
 * no-op rather than a duplicate. A project whose latest snapshot has no gaps is left alone, and one
 * that has never been analysed is skipped — there is nothing to read.
 */

import { prisma } from '../src/lib/prisma';
import { syncPlanningActions } from '../src/modules/input/input.service';
import type { PlanningGap } from '../src/modules/ai/provider';

const dryRun = process.argv.includes('--dry');

/**
 * `planningGaps` is a JSON column, so what comes back is whatever was written — including the shape
 * used before the field existed, which is `null`. Anything without a title is not a gap and is
 * dropped rather than written as a blank row in front of the PM.
 */
function readGaps(stored: unknown): PlanningGap[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .filter((entry) => typeof entry.title === 'string' && entry.title.trim())
    .map((entry) => ({
      title: String(entry.title).trim(),
      why: typeof entry.why === 'string' ? entry.why : '',
      documentName: typeof entry.documentName === 'string' ? entry.documentName : null,
      severity: entry.severity === 'HIGH' || entry.severity === 'LOW' ? entry.severity : 'MEDIUM',
    }));
}

async function main() {
  const projects = await prisma.project.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  console.log(`${projects.length} project(s)${dryRun ? ' — dry run, nothing will be written' : ''}\n`);

  let written = 0;
  let skipped = 0;

  for (const project of projects) {
    const latest = await prisma.aiApproachSuggestion.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      select: { planningGaps: true, createdAt: true },
    });

    if (!latest) {
      console.log(`  —    ${project.name}  (never analysed)`);
      skipped += 1;
      continue;
    }

    const gaps = readGaps(latest.planningGaps);
    if (!gaps.length) {
      console.log(`  —    ${project.name}  (analysed ${latest.createdAt.toISOString().slice(0, 10)}, no gaps recorded)`);
      skipped += 1;
      continue;
    }

    const open = await prisma.actionItem.count({ where: { projectId: project.id, status: 'OPEN', blocksDocument: null } });
    if (dryRun) {
      console.log(`  ${String(gaps.length).padStart(2)}   ${project.name}  (${open} open now)`);
      written += gaps.length;
      continue;
    }

    const count = await syncPlanningActions(project.id, gaps);
    console.log(`  ${String(count).padStart(2)}   ${project.name}`);
    written += count;
  }

  console.log(`\n${dryRun ? 'would write' : 'wrote'} ${written} action(s); skipped ${skipped} project(s)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
