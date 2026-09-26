/**
 * The Planning Assessment engine — the FPT standard, applied to one project.
 *
 * **Every rule is judged by the model against the project input**: the PM's recorded answers and
 * the text of every uploaded document. Checking whether a form field is non-empty cannot tell "TBD"
 * from a real answer, and cannot see a contract type stated in a SOW the form never asked about, so
 * no rule is settled by code. One call per category, in parallel — the four categories ask
 * genuinely different questions of the same material, and a single prompt of 147 mixed checks
 * drifted towards whichever category came first.
 *
 * **What the model said is kept, and what the PM has done since is laid on top.** A run is an
 * immutable snapshot. When a missing item's document is then generated and confirmed in Planning
 * Documents, or its PM action is closed, the row reads *Resolved* and counts as met — without
 * re-running the model, and without rewriting what the model said at the time. That is what makes
 * the FPT standard move as the PM works, and what keeps "what did the assessment find" answerable.
 *
 * **`UNKNOWN` never counts towards a score.** A percentage computed over a catalog half of which
 * could not be evaluated is a percentage nobody should act on, so unresolved rules leave the
 * denominator rather than quietly scoring as failures. The count travels with the score everywhere
 * it is shown.
 */
import { ActionPriority, DocumentStatus, ManagementDomain, type ProjectType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/http-error';
import {
  ACTIONABLE_CATEGORIES,
  ASSESSMENT_RULES,
  MISSING_DOCUMENT_FALLBACK,
  MISSING_INFORMATION_SUBJECT,
  RULE_BY_ID,
  TICK_CLOSE_REASON,
  type AssessmentCategory,
  type AssessmentRule,
  type RuleSeverity,
  type RuleStatus,
} from '../../data/assessment-rules';
import {
  judgeAssessmentRules,
  type AssessmentRuleForChange,
  type AssessmentUpdate,
  type EvidenceItem,
  type RuleJudgementRequest,
} from '../ai/provider';
import { logEvent } from '../audit/audit.service';
import { checklistScoreForProject } from '../checklist/checklist.service';

/** Per-document ceiling on the text handed to the model, matching the planning analysis. */
const DOCUMENT_CHARS = 20_000;

/** One stored answer — what the model said at run time, plus the document it tied the fix to. */
export interface RuleResult {
  ruleId: string;
  status: RuleStatus;
  /** One sentence saying what was found. */
  finding: string;
  evidence: EvidenceItem[];
  /** For a failed rule: what exactly to add. */
  action: string | null;
  /** For a failed rule: the catalog document the content belongs in, or null when it is an upload. */
  targetDocument: string | null;
  /** For a conditional rule: why it does or does not apply to this project. */
  applicability: string | null;
  /**
   * When this result was last judged, if later than the run it sits in. Set on the rules a plan
   * change moved: a merged snapshot carries forward everything else from the run before it, and a
   * PM action resolved *before* the change must not quietly resolve a rule the change just made
   * missing again. Absent: judged when the run was made.
   */
  judgedAt?: string;
}

/** How a rule came to be met after the run, if it was: a confirmed document, a closed action, or a PM tick. */
export interface Resolution {
  by: 'DOCUMENT' | 'ACTION' | 'PM';
  detail: string;
  at: Date | null;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The catalog document a Missing Document rule is closed by, for this project type.
 *
 * Taken from the rule's own artifact list in order — the first name the project type's catalog
 * actually holds — so an SI project closes MD-009 with a Resource Management Plan and an SM one with
 * a Skills & Capacity Plan. Deterministic on purpose: which document satisfies which rule is a fact
 * about the catalog, not a judgement about the project, and the Planning Documents filter and the
 * FPT score both depend on it being the same answer every time.
 */
function catalogDocumentFor(rule: AssessmentRule, catalog: string[]): string | null {
  if (rule.evaluate.kind !== 'ARTIFACT') return null;
  const byName = new Map(catalog.map((name) => [normalise(name), name]));
  for (const artifact of rule.evaluate.artifacts) {
    const hit = byName.get(normalise(artifact));
    if (hit) return hit;
  }
  return null;
}

type ProjectContext = {
  project: { id: string; name: string; type: ProjectType; customer: string | null };
  projectManager: string | null;
  governanceModel: string | null;
  inputs: { label: string; value: string }[];
  documents: { label: string; text: string }[];
  planningDocuments: { name: string; status: DocumentStatus }[];
  catalog: { name: string; domain: ManagementDomain }[];
};

async function loadContext(projectId: string): Promise<ProjectContext> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, type: true, customer: true, owner: { select: { name: true } } },
  });
  if (!project) throw notFound('Project not found');

  const [values, uploads, planningDocuments, decision, catalog] = await Promise.all([
    // Verified values only: invariant 1 — an unverified AI suggestion is a candidate, not a fact.
    prisma.projectInputValue.findMany({ where: { projectId, verified: true }, include: { definition: true } }),
    prisma.referenceFile.findMany({ where: { projectId, supersededAt: null }, orderBy: { uploadedAt: 'asc' } }),
    prisma.planningDocument.findMany({ where: { projectId }, select: { name: true, status: true } }),
    prisma.approachDecision.findFirst({ where: { projectId, active: true } }),
    // The standard catalog, plus any document an earlier assessment added to *this* project. An
    // extended document another project of the same type needed is not this project's to target.
    prisma.documentDefinition.findMany({
      where: { projectType: project.type, OR: [{ extended: false }, { documents: { some: { projectId } } }] },
      select: { name: true, domain: true },
    }),
  ]);

  return {
    project: { id: project.id, name: project.name, type: project.type, customer: project.customer },
    projectManager: project.owner?.name ?? null,
    governanceModel: decision?.approach ?? null,
    inputs: values
      .filter((row) => row.value?.trim())
      .map((row) => ({ label: row.definition.label, value: row.value!.trim() })),
    documents: uploads
      .map((file) => {
        const extraction = file.extraction as { rawText?: string; textAvailable?: boolean } | null;
        return extraction?.textAvailable && extraction.rawText
          ? { label: file.fileName, text: extraction.rawText.slice(0, DOCUMENT_CHARS) }
          : null;
      })
      .filter((entry): entry is { label: string; text: string } => entry !== null),
    planningDocuments,
    catalog,
  };
}

/**
 * Makes sure a missing document the standard catalog does not cover can be generated.
 *
 * Every document the assessment finds missing appears in Planning Documents — the catalog is not
 * the limit. When no catalog name covers a failed rule, the rule's fallback document is created as
 * an `extended` definition for this project type (once; later projects reuse it) and a NOT_GENERATED
 * row is provisioned for this project, which is what makes `catalogForProject` show it here and
 * nowhere else. Returns the name the PM action and the Planning Documents filter key on.
 */
async function provisionMissingDocument(
  projectId: string,
  projectType: ProjectType,
  rule: AssessmentRule,
): Promise<string | null> {
  const fallback = MISSING_DOCUMENT_FALLBACK[rule.ruleId];
  if (!fallback) return null;

  const definition = await prisma.documentDefinition.upsert({
    where: { projectType_domain_name: { projectType, domain: fallback.domain, name: fallback.name } },
    create: {
      projectType,
      domain: fallback.domain,
      name: fallback.name,
      requirement: rule.appliesWhen ? 'CONDITIONAL' : 'REQUIRED',
      description: `Added by the Planning Assessment (${rule.ruleId}: ${rule.name}).`,
      extended: true,
      // After the standard documents of its domain, so the catalog's own order is undisturbed.
      order: 100,
    },
    update: {},
  });

  await prisma.planningDocument.upsert({
    where: { projectId_definitionId: { projectId, definitionId: definition.id } },
    create: {
      projectId,
      definitionId: definition.id,
      name: definition.name,
      domain: definition.domain,
      requirement: definition.requirement,
      status: DocumentStatus.NOT_GENERATED,
    },
    update: {},
  });

  return definition.name;
}

/** Assessment severity → the three priorities the PM action center already draws. */
const ACTION_PRIORITY: Record<RuleSeverity, ActionPriority> = {
  BLOCKER: ActionPriority.REQUIRED,
  HIGH: ActionPriority.REQUIRED,
  MEDIUM: ActionPriority.CONDITIONAL,
  LOW: ActionPriority.INFO,
  INFO: ActionPriority.INFO,
};

/**
 * Rebuilds the PM action center from what this run found missing.
 *
 * Every failed Missing Information and Missing Document rule becomes one action, carrying the
 * model's specific instruction as its description and the document it belongs in as its target —
 * so *View* lands on that document in Planning Documents, and confirming the document there marks
 * the action ready to close. Risks and conflicts stay on the assessment screen: they are findings to
 * weigh, not holes with a definite thing to add.
 *
 * The same three rules as the gap-based sync this replaces, for the same reasons:
 *
 * - **The OPEN set is replaced; RESOLVED and DISMISSED rows stay as history.** A rule the PM closed
 *   that the new run still reports comes back, because the new read still says it is missing.
 * - **`blocksDocument` stays null, and the delete is scoped to rows where it already is**, so a
 *   missing Charter never blocks generating the Charter, and a hand-made blocker survives a re-run.
 * - **The domain comes from the catalog entry, never from the model.**
 */
async function syncAssessmentActions(projectId: string, results: RuleResult[], context: ProjectContext) {
  const domainOf = new Map(context.catalog.map((entry) => [entry.name, entry.domain]));

  await prisma.actionItem.deleteMany({ where: { projectId, status: 'OPEN', blocksDocument: null } });

  const rows = results
    .map((result) => ({ result, rule: RULE_BY_ID.get(result.ruleId) }))
    .filter(
      (entry): entry is { result: RuleResult; rule: AssessmentRule } =>
        Boolean(entry.rule) &&
        ACTIONABLE_CATEGORIES.includes(entry.rule!.assessmentCategory) &&
        entry.result.status === 'FAIL',
    );
  if (!rows.length) return 0;

  const { count } = await prisma.actionItem.createMany({
    data: rows.map(({ result, rule }) => ({
      projectId,
      ruleId: rule.ruleId,
      priority: ACTION_PRIORITY[rule.result.severity],
      domain: (result.targetDocument && domainOf.get(result.targetDocument)) || ManagementDomain.GOVERNANCE,
      title: rule.result.message,
      description: result.action ?? rule.result.recommendedAction,
      // Planning Documents when the fix is a document this app generates; otherwise it is something
      // the PM supplies, and that happens on Project Input.
      targetView: result.targetDocument ? 'studio' : 'input',
      targetDocument: result.targetDocument,
      suggestions: result.targetDocument ? [result.targetDocument] : [],
    })),
  });
  return count;
}

/**
 * Runs the whole catalog against one project and stores the snapshot.
 */
export async function runAssessment(projectId: string, actorId: string) {
  const context = await loadContext(projectId);
  const catalogNames = context.catalog.map((entry) => entry.name);

  const categories: AssessmentCategory[] = ['MISSING_INFORMATION', 'MISSING_DOCUMENT', 'PLANNING_RISK', 'CONFLICT'];

  const judgements = (
    await Promise.all(
      categories.map((category) =>
        judgeAssessmentRules({
          projectName: context.project.name,
          projectType: context.project.type,
          governanceModel: context.governanceModel,
          projectManager: context.projectManager,
          inputs: context.inputs,
          documents: context.documents,
          // Missing information and missing documents are judged on the project input alone. A
          // draft this application wrote is not evidence that the project supplied anything, so the
          // two input-only categories are not shown the drafts at all.
          planningDocuments: ACTIONABLE_CATEGORIES.includes(category)
            ? []
            : context.planningDocuments.map((doc) => ({ name: doc.name, status: doc.status })),
          catalogDocuments: catalogNames,
          rules: ASSESSMENT_RULES.filter((rule) => rule.assessmentCategory === category).map(
            (rule): RuleJudgementRequest => ({
              ruleId: rule.ruleId,
              category: rule.assessmentCategory,
              question:
                rule.evaluate.kind === 'JUDGEMENT'
                  ? rule.evaluate.question
                  : `Does the project input provide the ${rule.name}, as its own document or as an equivalent section?`,
              appliesWhen: rule.appliesWhen,
              message: rule.result.message,
              ...(rule.evaluate.kind === 'ARTIFACT' ? { acceptableAs: rule.evaluate.artifacts } : {}),
            }),
          ),
        }),
      ),
    )
  ).flat();

  const byId = new Map(judgements.map((row) => [row.ruleId, row]));

  const results: RuleResult[] = ASSESSMENT_RULES.map((rule) => {
    const judged = byId.get(rule.ruleId);
    const status = judged?.status ?? 'UNKNOWN';
    const failed = status === 'FAIL';
    return {
      ruleId: rule.ruleId,
      // A rule the model simply did not answer is UNKNOWN, never a pass. Silence is not a tick.
      status,
      finding: judged?.finding || (judged ? '' : 'The model did not return an answer for this check.'),
      evidence: judged?.evidence ?? [],
      action: failed ? judged?.action ?? rule.result.recommendedAction : null,
      /**
       * A missing document is tied to the catalog document the rule names for this project type;
       * the model's own suggestion is the fallback, for a rule whose content can live inside
       * another document (a CM section in the operating model). Missing information goes wherever
       * the model placed it — which document a fact belongs in is a judgement about the project.
       */
      targetDocument: failed
        ? rule.assessmentCategory === 'MISSING_DOCUMENT'
          ? catalogDocumentFor(rule, catalogNames) ?? judged?.targetDocument ?? null
          : judged?.targetDocument ?? null
        : null,
      applicability: judged?.applicability ?? null,
    };
  });

  // A missing document with no standard catalog entry still gets one, so it can be generated in
  // Planning Documents instead of reading "missing" with no way to close it.
  for (const result of results) {
    const rule = RULE_BY_ID.get(result.ruleId)!;
    if (result.status === 'FAIL' && rule.assessmentCategory === 'MISSING_DOCUMENT' && !result.targetDocument) {
      result.targetDocument = await provisionMissingDocument(projectId, context.project.type, rule);
    }
  }
  const domainOf = new Map(context.catalog.map((entry) => [entry.name, entry.domain]));
  for (const result of results) {
    if (result.targetDocument && !domainOf.has(result.targetDocument)) {
      const fallback = MISSING_DOCUMENT_FALLBACK[result.ruleId];
      if (fallback) context.catalog.push({ name: fallback.name, domain: fallback.domain });
    }
  }

  const fpt = scoreCategory(results, 'MISSING_DOCUMENT');
  const blockers = results.filter((result) => result.status === 'FAIL' && RULE_BY_ID.get(result.ruleId)?.mandatory).length;
  const unknowns = results.filter((result) => result.status === 'UNKNOWN').length;

  const run = await prisma.assessmentRun.create({
    data: {
      projectId,
      results: results as unknown as object[],
      fptScore: fpt.score,
      unknowns,
      blockers,
      aiProvider: 'anthropic',
    },
  });

  const actions = await syncAssessmentActions(projectId, results, context);

  await logEvent({
    projectId,
    actorId,
    actorType: 'AGENT',
    type: 'ASSESSMENT_RUN',
    title: 'Planning Assessment run',
    detail: `${results.length} rules · FPT standard ${fpt.score}% · ${blockers} blocker${blockers === 1 ? '' : 's'} · ${actions} PM action${actions === 1 ? '' : 's'} · ${unknowns} not evaluated`,
    payload: { runId: run.id, fptScore: fpt.score, blockers, unknowns, actions },
  });

  return (await latestAssessment(projectId))!;
}

/** When a result was judged: its own time when a plan change moved it, else the run's. */
const judgedAtOf = (result: RuleResult, runAt: Date) => (result.judgedAt ? new Date(result.judgedAt) : runAt);

function earliestJudged(runAt: Date, results: RuleResult[]) {
  return results.reduce((earliest, result) => {
    const at = judgedAtOf(result, runAt);
    return at < earliest ? at : earliest;
  }, runAt);
}

/**
 * What the PM has done since the run, per failed rule: a confirmed document in Planning Documents,
 * or a closed PM action. Read live, so the screen and the score move without a model call.
 */
async function resolutionsFor(projectId: string, runAt: Date, results: RuleResult[]) {
  const [documents, actions] = await Promise.all([
    prisma.planningDocument.findMany({
      where: { projectId, status: DocumentStatus.APPROVED },
      select: { name: true, approvedAt: true },
    }),
    // Resolved by the PM since the run, whether or not they have also closed it: pressing Resolve is
    // the PM saying the item is handled, and Close only takes it off their list. The earliest judging
    // time in the run bounds the query; each rule is then checked against its own time below.
    prisma.actionItem.findMany({
      where: { projectId, ruleId: { not: null }, resolvedAt: { gte: earliestJudged(runAt, results) } },
      select: { ruleId: true, resolvedValue: true, resolvedAt: true },
      orderBy: { resolvedAt: 'desc' },
    }),
  ]);
  const approved = new Map(documents.map((doc) => [doc.name, doc.approvedAt]));
  const closed = new Map<string, (typeof actions)[number]>();
  for (const action of actions) if (!closed.has(action.ruleId!)) closed.set(action.ruleId!, action);

  const resolutions = new Map<string, Resolution>();
  for (const result of results) {
    if (result.status !== 'FAIL') continue;
    if (result.targetDocument && approved.has(result.targetDocument)) {
      resolutions.set(result.ruleId, {
        by: 'DOCUMENT',
        detail: `${result.targetDocument} confirmed by the PM in Planning Artifacts`,
        at: approved.get(result.targetDocument) ?? null,
      });
      continue;
    }
    const action = closed.get(result.ruleId);
    // Only a resolution made after this rule was last judged counts for it.
    if (action && action.resolvedAt && action.resolvedAt >= judgedAtOf(result, runAt)) {
      resolutions.set(result.ruleId, {
        by: 'ACTION',
        detail: action.resolvedValue ?? 'Resolved by the PM',
        at: action.resolvedAt,
      });
    }
  }
  return resolutions;
}

/** A resolved failure counts as met. The stored snapshot keeps the model's original FAIL. */
function withResolutions(results: RuleResult[], resolutions: Map<string, Resolution>): RuleResult[] {
  return results.map((result) => (resolutions.has(result.ruleId) ? { ...result, status: 'PASS' as const } : result));
}

/**
 * Weighted share of the rules in a category that passed, with everything unresolved left out of
 * both halves of the fraction.
 */
export function scoreCategory(results: RuleResult[], category: AssessmentCategory) {
  const scored = results
    .map((result) => ({ result, rule: RULE_BY_ID.get(result.ruleId) }))
    .filter(
      (entry): entry is { result: RuleResult; rule: AssessmentRule } =>
        Boolean(entry.rule) && entry.rule!.assessmentCategory === category,
    );

  const counted = scored.filter((entry) => entry.result.status === 'PASS' || entry.result.status === 'FAIL');
  const passed = counted.filter((entry) => entry.result.status === 'PASS');
  const weight = counted.reduce((sum, entry) => sum + entry.rule.weight, 0);
  const passedWeight = passed.reduce((sum, entry) => sum + entry.rule.weight, 0);

  return {
    score: weight ? Math.round((passedWeight / weight) * 100) : 0,
    passed: passed.length,
    failed: counted.length - passed.length,
    /** Assessed = PASS + FAIL. The two below are deliberately not in it. */
    assessed: counted.length,
    unknown: scored.filter((entry) => entry.result.status === 'UNKNOWN').length,
    notApplicable: scored.filter((entry) => entry.result.status === 'NOT_APPLICABLE').length,
    total: scored.length,
    blockers: counted.filter((entry) => entry.result.status === 'FAIL' && entry.rule.mandatory).length,
  };
}

const SEVERITY_ORDER = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };
const STATUS_ORDER: Record<RuleStatus, number> = { FAIL: 0, UNKNOWN: 1, OVERRIDDEN: 2, PASS: 3, NOT_APPLICABLE: 4 };

/**
 * The two-tier standards and the Planning readiness figure, from one place.
 *
 * **Two tiers, in precedence order.** The FPT standard is the company baseline and applies to every
 * project — it is exactly the `MISSING_DOCUMENT` rules, so "every required document confirmed" and
 * "FPT standard fulfilled" are the same statement rather than two numbers that can disagree. The
 * customer standard is laid on top and is whichever customer this project matched, which is a
 * different checklist for LGCNS than for SKAX.
 *
 * **Planning readiness = 60% customer + 40% FPT, and FPT alone when there is no customer.**
 */
export function standardsFor(
  fptScore: number,
  checklist: { score: number; coverage: number; stale: boolean } | null,
  customer: string | null,
) {
  const customerCounts = Boolean(checklist && checklist.coverage > 0);
  return {
    fpt: { label: 'FPT standards', score: fptScore, note: 'Company baseline · always applied' },
    customer: customerCounts
      ? {
          label: `${customer ?? 'Customer'} standards`,
          score: checklist!.score,
          coverage: checklist!.coverage,
          stale: checklist!.stale,
          note: 'Applied on top of the FPT baseline',
        }
      : null,
    readiness: customerCounts ? Math.round(checklist!.score * 0.6 + fptScore * 0.4) : fptScore,
    basis: customerCounts ? ('CUSTOMER_AND_FPT' as const) : ('FPT_ONLY' as const),
  };
}

/**
 * The PM's ticks, laid on top of everything else. A tick outranks the model and the derived
 * resolutions — it is the PM's own verdict — and survives re-runs, because it is not stored in the run.
 */
function withVerdicts(
  results: RuleResult[],
  resolutions: Map<string, Resolution>,
  verdicts: { ruleId: string; met: boolean; updatedAt: Date }[],
) {
  const byRule = new Map(verdicts.map((verdict) => [verdict.ruleId, verdict]));
  const merged = new Map(resolutions);
  const effective = results.map((result) => {
    const verdict = byRule.get(result.ruleId);
    if (!verdict) return result;
    if (verdict.met) {
      merged.set(result.ruleId, { by: 'PM', detail: 'Ticked as met by the PM', at: verdict.updatedAt });
      return { ...result, status: 'PASS' as const };
    }
    merged.delete(result.ruleId);
    return { ...result, status: 'FAIL' as const };
  });
  return { effective, resolutions: merged };
}

async function loadLatest(projectId: string) {
  const run = await prisma.assessmentRun.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  if (!run) return null;
  const stored = run.results as unknown as RuleResult[];
  const [derived, verdicts] = await Promise.all([
    resolutionsFor(projectId, run.createdAt, stored),
    prisma.assessmentOverride.findMany({ where: { projectId }, select: { ruleId: true, met: true, updatedAt: true } }),
  ]);
  /** Before the PM's ticks — what the model plus the PM's documents and actions say on their own. */
  const withoutVerdicts = withResolutions(stored, derived);
  const { effective, resolutions } = withVerdicts(withoutVerdicts, derived, verdicts);
  return {
    run,
    stored,
    resolutions,
    effective,
    withoutVerdicts,
    verdicts: new Map(verdicts.map((verdict) => [verdict.ruleId, verdict.met])),
  };
}

/**
 * The PM ticks (or unticks) a rule in the Standards popup.
 *
 * Stored only where the tick disagrees with what the assessment already says on its own — ticking
 * a rule the model already found met, or unticking one it found missing, just clears any earlier
 * verdict. So the table holds exactly the PM's disagreements, and a later re-run that comes round
 * to the PM's view leaves nothing redundant behind.
 */
export async function setRuleVerdict(params: { projectId: string; ruleId: string; met: boolean; actorId: string }) {
  const rule = RULE_BY_ID.get(params.ruleId);
  if (!rule) throw notFound('No such rule in the catalog');
  if (!(await prisma.assessmentRun.count({ where: { projectId: params.projectId } }))) {
    throw badRequest('Run the Planning Assessment first — there is nothing to confirm yet.');
  }

  /**
   * Unticking withdraws the claim a PM action was closed on, so that action comes back — the same
   * rule as deleting the document an action was closed for (`reopenActionsForDocument`). Done before
   * the comparison below: otherwise the closed action would itself count as the rule being resolved,
   * and the untick would be stored as a "not met" verdict fighting it instead of simply undoing the tick.
   */
  if (!params.met) {
    await prisma.actionItem.updateMany({
      where: { projectId: params.projectId, ruleId: params.ruleId, status: 'RESOLVED', resolvedValue: TICK_CLOSE_REASON },
      data: { status: 'OPEN', resolvedValue: null, resolvedAt: null },
    });
  }
  const latest = (await loadLatest(params.projectId))!;

  const onItsOwn = latest.withoutVerdicts.find((result) => result.ruleId === params.ruleId)?.status === 'PASS';
  if (onItsOwn === params.met) {
    await prisma.assessmentOverride.deleteMany({ where: { projectId: params.projectId, ruleId: params.ruleId } });
  } else {
    await prisma.assessmentOverride.upsert({
      where: { projectId_ruleId: { projectId: params.projectId, ruleId: params.ruleId } },
      create: { projectId: params.projectId, ruleId: params.ruleId, met: params.met, byId: params.actorId },
      update: { met: params.met, byId: params.actorId },
    });
  }

  await logEvent({
    projectId: params.projectId,
    actorId: params.actorId,
    actorType: 'PM',
    type: 'ASSESSMENT_RULE_CONFIRMED',
    title: `PM marked ${rule.ruleId} ${params.met ? 'met' : 'not met'}`,
    detail: rule.name,
    payload: { ruleId: rule.ruleId, met: params.met },
  });

  return latestAssessment(params.projectId);
}

/** The newest run, decorated for the screen, or null when the project has never been assessed. */
export async function latestAssessment(projectId: string) {
  const latest = await loadLatest(projectId);
  if (!latest) return null;
  const { run, stored, resolutions, effective, verdicts } = latest;

  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { customer: true } });
  const checklist = await checklistScoreForProject(projectId);
  const documents = await prisma.planningDocument.findMany({
    where: { projectId },
    select: { name: true, status: true, staleReason: true },
  });
  const documentStatus = new Map(documents.map((doc) => [doc.name, doc.status]));
  const documentStale = new Map(documents.map((doc) => [doc.name, doc.staleReason]));

  const storedById = new Map(stored.map((result) => [result.ruleId, result]));
  const rows = effective
    .map((result) => {
      const rule = RULE_BY_ID.get(result.ruleId);
      if (!rule) return null; // A rule retired since the run. Its answer is history, not a finding.
      return {
        ...result,
        /** What the model said at run time — FAIL for a row the PM has since resolved. */
        assessedStatus: storedById.get(result.ruleId)?.status ?? result.status,
        resolution: resolutions.get(result.ruleId) ?? null,
        /** The PM's own tick, when they have disagreed with the assessment. */
        pmVerdict: verdicts.has(result.ruleId) ? (verdicts.get(result.ruleId) ? 'MET' : 'NOT_MET') : null,
        /** Where the target document is in Planning Documents — Not started / PM review / Approved. */
        targetDocumentStatus: result.targetDocument ? documentStatus.get(result.targetDocument) ?? 'NOT_GENERATED' : null,
        /** Why a plan change marked the target document out of date, or null when it is current. */
        targetDocumentStale: result.targetDocument ? documentStale.get(result.targetDocument) ?? null : null,
        name: rule.name,
        category: rule.assessmentCategory,
        severity: rule.result.severity,
        message: rule.result.message,
        recommendedAction: rule.result.recommendedAction,
        appliesWhen: rule.appliesWhen,
        mandatory: rule.mandatory,
        weight: rule.weight,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.ruleId.localeCompare(b.ruleId),
    );

  const fpt = scoreCategory(effective, 'MISSING_DOCUMENT');

  // The same set `loadInput` reads — every current upload — so the figure is the evidence the next
  // assessment will see. `readable` is what actually reaches the model: a scan with no text layer
  // is uploaded but says nothing.
  const uploads = await prisma.referenceFile.findMany({
    where: { projectId, supersededAt: null },
    select: { extraction: true },
  });
  const readable = uploads.filter((file) => {
    const extraction = file.extraction as { rawText?: string; textAvailable?: boolean } | null;
    return Boolean(extraction?.textAvailable && extraction.rawText);
  }).length;

  return {
    runId: run.id,
    at: run.createdAt,
    aiProvider: run.aiProvider,
    evidence: { files: uploads.length, readable },
    rows,
    categories: {
      MISSING_INFORMATION: scoreCategory(effective, 'MISSING_INFORMATION'),
      MISSING_DOCUMENT: fpt,
      PLANNING_RISK: scoreCategory(effective, 'PLANNING_RISK'),
      CONFLICT: scoreCategory(effective, 'CONFLICT'),
    },
    standards: standardsFor(fpt.score, checklist, project?.customer ?? null),
  };
}

/**
 * The FPT standard score, for the readiness maths — live, so confirming a document in Planning
 * Documents moves Planning readiness immediately. Reads the stored snapshot and the documents; it
 * never calls the model, because readiness is computed on every dashboard load.
 *
 * Null means the assessment has never been run, which is not the same as scoring zero.
 */
export async function fptStandardScore(projectId: string): Promise<number | null> {
  const latest = await loadLatest(projectId);
  return latest ? scoreCategory(latest.effective, 'MISSING_DOCUMENT').score : null;
}

/**
 * The documents Planning Documents should show: the catalog documents that close a Missing
 * Document rule the assessment found failing. A document stays in the list once it is confirmed —
 * it was needed, and the PM should see it done rather than watch it vanish.
 *
 * Null when the project has never been assessed, which the caller reads as "no filter".
 */
export async function missingDocumentNames(projectId: string): Promise<string[] | null> {
  const run = await prisma.assessmentRun.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { results: true },
  });
  if (!run) return null;
  const names = (run.results as unknown as RuleResult[])
    .filter((result) => result.status === 'FAIL' && RULE_BY_ID.get(result.ruleId)?.assessmentCategory === 'MISSING_DOCUMENT')
    .map((result) => result.targetDocument)
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

/**
 * What drafting one document needs to know from the Planning Assessment.
 *
 * `knownGaps` — every Missing Information finding still unresolved, each marked with whether the
 * assessment tied it to *this* document. The drafter must ask the PM for those, and the caller adds
 * any it leaves out: a fact the assessment already knows is missing has to reach the PM as a
 * question, not depend on the model happening to notice it.
 *
 * `confirmed` — facts the PM has since supplied by resolving a finding (in PM Actions, or by
 * answering a document's question), as label/value pairs the drafter can use like any verified
 * input. Otherwise the PM would answer "contract type" once and be asked it again in every document.
 */
export async function missingInformationForDocument(projectId: string, documentName: string) {
  const latest = await loadLatest(projectId);
  if (!latest) return { knownGaps: [], confirmed: [] };
  const isInformation = (ruleId: string) => RULE_BY_ID.get(ruleId)?.assessmentCategory === 'MISSING_INFORMATION';

  const knownGaps = latest.effective
    .filter((result) => isInformation(result.ruleId) && result.status === 'FAIL')
    .map((result) => {
      const rule = RULE_BY_ID.get(result.ruleId)!;
      return {
        ruleId: rule.ruleId,
        missing: rule.result.message,
        ask: result.action ?? rule.result.recommendedAction,
        forThisDocument: result.targetDocument === documentName,
      };
    });

  const confirmed = [...latest.resolutions.entries()]
    .filter(([ruleId, resolution]) => isInformation(ruleId) && resolution.by === 'ACTION' && resolution.detail.trim())
    .map(([ruleId, resolution]) => ({
      label: MISSING_INFORMATION_SUBJECT[ruleId] ?? RULE_BY_ID.get(ruleId)!.name,
      value: resolution.detail.trim(),
    }));

  return { knownGaps, confirmed };
}

/** Whether this project has ever been assessed — the gap-based action sync defers to it once it has. */
export async function hasAssessment(projectId: string): Promise<boolean> {
  return (await prisma.assessmentRun.count({ where: { projectId } })) > 0;
}

/** The question a rule asks, worded the same way for the assessment and for the change call. */
function questionFor(rule: AssessmentRule): string {
  return rule.evaluate.kind === 'JUDGEMENT'
    ? rule.evaluate.question
    : `Does the project input provide the ${rule.name}, as its own document or as an equivalent section?`;
}

/**
 * The Missing Information and Missing Documents rules with their current result, for the plan
 * change call — so it can say which of them the change moves. Current means what the PM sees: the
 * model's answer with confirmed documents, resolved actions and ticks laid on top. Empty when the
 * project has never been assessed; the change call then leaves the assessment alone.
 */
export async function assessmentRulesForChange(projectId: string): Promise<AssessmentRuleForChange[]> {
  const latest = await loadLatest(projectId);
  if (!latest) return [];
  const effective = new Map(latest.effective.map((result) => [result.ruleId, result]));
  return ASSESSMENT_RULES.filter((rule) => ACTIONABLE_CATEGORIES.includes(rule.assessmentCategory)).map((rule) => {
    const result = effective.get(rule.ruleId);
    const status = result?.status ?? 'UNKNOWN';
    return {
      ruleId: rule.ruleId,
      category: rule.assessmentCategory as AssessmentRuleForChange['category'],
      question: questionFor(rule),
      appliesWhen: rule.appliesWhen,
      current: status === 'OVERRIDDEN' ? 'PASS' : status,
      finding: (result?.finding ?? '').slice(0, 200),
    };
  });
}

/**
 * Applies what a plan change said about Missing Information and Missing Documents.
 *
 * **A new snapshot, merged — never an edit, never a re-run.** The latest run's results are carried
 * forward and only the rules the change moved are replaced, each stamped with `judgedAt`, so the two
 * tabs, the FPT standard and Planning readiness follow the change with no further model call.
 * Everything else — risks, conflicts, every rule the change did not touch — keeps its last assessed
 * result; Re-assess still re-judges the lot.
 *
 * **PM actions are updated per rule, not rebuilt.** A rebuild would delete actions the PM had
 * resolved but not yet closed on rules this change never touched. So: a rule the change makes
 * missing gets its action (created, or re-opened with its resolution cleared — the change has just
 * undone it); a rule the change settles has its open action closed, recording that the change
 * settled it. Nothing else moves.
 */
export async function applyAssessmentUpdates(params: {
  projectId: string;
  updates: AssessmentUpdate[];
  actorId: string;
  changeSummary: string;
}) {
  const latest = await loadLatest(params.projectId);
  if (!latest || !params.updates.length) return null;
  const context = await loadContext(params.projectId);
  const catalogNames = context.catalog.map((entry) => entry.name);
  const now = new Date();
  const byRule = new Map(params.updates.map((update) => [update.ruleId, update]));
  const baseTime = latest.run.createdAt.toISOString();

  const results: RuleResult[] = latest.stored.map((result) => {
    const update = byRule.get(result.ruleId);
    const rule = RULE_BY_ID.get(result.ruleId);
    // Carried forward with the time it was really judged, so resolutions made since still count.
    if (!update || !rule) return { ...result, judgedAt: result.judgedAt ?? baseTime };
    const failed = update.status === 'FAIL';
    return {
      ruleId: result.ruleId,
      status: update.status,
      finding: update.finding,
      evidence: update.evidence,
      action: failed ? update.action ?? rule.result.recommendedAction : null,
      targetDocument: failed
        ? rule.assessmentCategory === 'MISSING_DOCUMENT'
          ? catalogDocumentFor(rule, catalogNames) ?? update.targetDocument
          : update.targetDocument
        : null,
      applicability: update.applicability ?? result.applicability,
      judgedAt: now.toISOString(),
    };
  });

  for (const result of results) {
    const rule = RULE_BY_ID.get(result.ruleId);
    if (byRule.has(result.ruleId) && rule && result.status === 'FAIL' && rule.assessmentCategory === 'MISSING_DOCUMENT' && !result.targetDocument) {
      result.targetDocument = await provisionMissingDocument(params.projectId, context.project.type, rule);
      const fallback = MISSING_DOCUMENT_FALLBACK[result.ruleId];
      if (fallback) context.catalog.push({ name: fallback.name, domain: fallback.domain });
    }
  }

  const fpt = scoreCategory(results, 'MISSING_DOCUMENT');
  const run = await prisma.assessmentRun.create({
    data: {
      projectId: params.projectId,
      results: results as unknown as object[],
      fptScore: fpt.score,
      unknowns: results.filter((result) => result.status === 'UNKNOWN').length,
      blockers: results.filter((result) => result.status === 'FAIL' && RULE_BY_ID.get(result.ruleId)?.mandatory).length,
      aiProvider: latest.run.aiProvider,
    },
  });

  const domainOf = new Map(context.catalog.map((entry) => [entry.name, entry.domain]));
  let nowMissing = 0;
  let settled = 0;
  for (const result of results.filter((entry) => byRule.has(entry.ruleId))) {
    const rule = RULE_BY_ID.get(result.ruleId)!;
    const open = await prisma.actionItem.findMany({
      where: { projectId: params.projectId, ruleId: result.ruleId, status: 'OPEN', blocksDocument: null },
    });
    if (result.status === 'FAIL') {
      nowMissing += 1;
      const data = {
        priority: ACTION_PRIORITY[rule.result.severity],
        domain: (result.targetDocument && domainOf.get(result.targetDocument)) || ManagementDomain.GOVERNANCE,
        title: rule.result.message,
        description: result.action ?? rule.result.recommendedAction,
        targetView: result.targetDocument ? 'studio' : 'input',
        targetDocument: result.targetDocument,
        suggestions: result.targetDocument ? [result.targetDocument] : [],
        resolvedAt: null,
        resolvedValue: null,
      };
      if (open.length) {
        await prisma.actionItem.update({ where: { id: open[0].id }, data });
      } else {
        await prisma.actionItem.create({ data: { projectId: params.projectId, ruleId: result.ruleId, ...data } });
      }
    } else {
      settled += 1;
      if (open.length) {
        await prisma.actionItem.updateMany({
          where: { id: { in: open.map((action) => action.id) } },
          data: {
            status: 'RESOLVED',
            resolvedAt: now,
            resolvedValue: `Settled by a plan change: ${params.changeSummary || result.finding}`.slice(0, 500),
          },
        });
      }
    }
  }

  await logEvent({
    projectId: params.projectId,
    actorId: params.actorId,
    actorType: 'AGENT',
    type: 'ASSESSMENT_UPDATED_BY_CHANGE',
    title: 'Planning Assessment updated from a plan change',
    detail: `${nowMissing} now missing · ${settled} now provided or not applicable · FPT standard ${fpt.score}%`,
    payload: { runId: run.id, basedOn: latest.run.id, rules: params.updates.map((update) => update.ruleId) },
  });

  return { runId: run.id, nowMissing, settled, fptScore: fpt.score };
}
