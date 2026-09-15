/**
 * Rewrites PM confirmation questions that were drafted before the English-interface rule into
 * English, in place.
 *
 * `PlanningDocument.pmQuestions` is persisted at generation time, so a prompt corrected afterwards
 * cannot fix what is already stored — a document generated earlier keeps asking the PM in Korean.
 * Regenerating the document would also fix it, at the price of a full drafting call and of any
 * answers the PM has already typed; this rewrites only the `question` text and leaves each gap's
 * `token` and `answer` untouched.
 *
 *   npm run db:fix:gap-language            # every document that needs it
 *   npm run db:fix:gap-language -- --dry   # report only, no model call, no write
 *
 * Costs one model call per document that has non-English questions. Safe to re-run: a document
 * whose questions are already English is skipped, so nothing is paid for twice.
 */

import { prisma } from '../src/lib/prisma';
import { translateGapQuestions } from '../src/modules/ai/provider';

interface StoredGap {
  token: string;
  question: string;
  answer: string | null;
}

const NON_LATIN = /[ㄱ-힝぀-ヿ一-鿿]/g;

/**
 * Anything the writer set aside in brackets: a placeholder token, a gloss, a quoted source term.
 * These are exactly the parts that may legitimately be non-English inside an English sentence.
 */
const BRACKETED = /\[[^\]]*\]|\([^)]*\)|<[^>]*>|「[^」]*」|“[^”]*”|"[^"]*"/g;

/**
 * Is the *sentence* written in another language, as opposed to merely containing a foreign word?
 *
 * The distinction is the whole difficulty. "Who is the customer-side sponsor (발주사 책임자)?" is a
 * correct English question quoting the customer's own term, and rewriting it would throw that term
 * away. "SK측 PM의 이름은 무엇입니까? — [SK PM Name]" is a Korean question with an English
 * placeholder stuck on the end, and a plain character ratio reads it as two-thirds Latin.
 *
 * So bracketed segments are removed first — placeholders, glosses and quotes all live there — and
 * only what is left, the sentence the PM actually reads, is measured.
 */
function isForeign(question: string): boolean {
  const sentence = (question ?? '').replace(BRACKETED, ' ').replace(/[\s—–-]+/g, '');
  if (!sentence) return false;
  const foreign = (sentence.match(NON_LATIN) ?? []).length;
  return foreign / sentence.length > 0.2;
}

async function main() {
  const dryRun = process.argv.includes('--dry');

  const documents = await prisma.planningDocument.findMany({
    where: { status: { not: 'NOT_GENERATED' } },
    include: { project: { select: { name: true } } },
    orderBy: { generatedAt: 'asc' },
  });

  let rewritten = 0;
  let skipped = 0;

  for (const document of documents) {
    const gaps = (document.pmQuestions as unknown as StoredGap[]) ?? [];
    const foreign = gaps.filter((gap) => isForeign(gap.question));
    if (!foreign.length) {
      if (gaps.length) skipped += 1;
      continue;
    }

    const label = `${document.project.name} · ${document.name} v${document.version}`;
    console.log(`\n${label} — ${foreign.length} of ${gaps.length} question(s) to rewrite`);
    if (dryRun) {
      for (const gap of foreign) console.log(`   ${gap.token}  ${gap.question}`);
      continue;
    }

    const translations = await translateGapQuestions(
      foreign.map((gap) => ({ id: gap.token, text: gap.question })),
    );
    const byToken = new Map(translations.map((entry) => [entry.id, entry.english?.trim()]));

    const next = gaps.map((gap) => {
      const english = byToken.get(gap.token);
      // An answered gap keeps its answer: only the wording of the question changes.
      return english ? { ...gap, question: english } : gap;
    });

    const changed = next.filter((gap, index) => gap.question !== gaps[index].question).length;
    if (!changed) {
      console.log('   nothing came back — left exactly as it was');
      continue;
    }

    await prisma.planningDocument.update({
      where: { id: document.id },
      data: { pmQuestions: next as unknown as object[] },
    });
    rewritten += 1;
    for (const gap of next.filter((_gap, index) => next[index].question !== gaps[index].question)) {
      console.log(`   ${gap.token}  ${gap.question}`);
    }
  }

  console.log(
    `\n${dryRun ? '[dry run] ' : ''}${rewritten} document(s) rewritten · ${skipped} already in English`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
