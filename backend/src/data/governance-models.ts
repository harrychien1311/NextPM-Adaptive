/**
 * The default governance model list the AI scores against (instruction.md "Supported
 * Governance Models"). The AI may propose another model when project evidence clearly
 * calls for it (e.g. PRINCE2, Lean) — GOVERNANCE_MODEL_META and GOVERNANCE_ARTIFACT_GUIDANCE
 * fall back to a generic entry for any code not in this list, so nothing breaks.
 */
export const DEFAULT_GOVERNANCE_MODELS = ['WATERFALL', 'SCRUM', 'KANBAN', 'HYBRID', 'ITERATIVE', 'STAGE_GATE'] as const;

export type GovernanceModelCode = (typeof DEFAULT_GOVERNANCE_MODELS)[number];

export interface GovernanceModelMeta {
  title: string;
  tagline: string;
  summary: string;
  rigor: string;
  controls: Record<string, string>;
}

export const GOVERNANCE_MODEL_META: Record<GovernanceModelCode, GovernanceModelMeta> = {
  WATERFALL: {
    title: 'Waterfall',
    tagline: 'Plan-driven, phase-gated',
    summary: 'Sequential phases with formal sign-off at each gate — best when scope and requirements are stable.',
    rigor: 'Formal rigor',
    controls: {
      'Planning horizon': 'Full baseline before execution',
      'Requirement control': 'Signed requirements baseline',
      'Change control': 'Formal change request board',
      'Customer decisions': 'Milestone sign-off',
      'Risk review': 'Phase-gate risk review',
    },
  },
  SCRUM: {
    title: 'Scrum',
    tagline: 'Iterative, backlog-driven',
    summary: 'Fixed-length sprints with a prioritized backlog and continuous stakeholder feedback.',
    rigor: 'Lightweight rigor',
    controls: {
      'Planning horizon': 'Rolling sprint backlog',
      'Requirement control': 'Prioritized product backlog',
      'Change control': 'Backlog re-prioritization each sprint',
      'Customer decisions': 'Embedded product owner',
      'Risk review': 'Sprint review + retrospective',
    },
  },
  KANBAN: {
    title: 'Kanban',
    tagline: 'Continuous flow',
    summary: 'Continuous delivery with WIP limits — suited to ongoing operational or support work with no fixed end date.',
    rigor: 'Lightweight rigor',
    controls: {
      'Planning horizon': 'Continuous flow, no fixed horizon',
      'Requirement control': 'Board policy per class of service',
      'Change control': 'Flexible via WIP limits',
      'Customer decisions': 'Continuous board review',
      'Risk review': 'Blocker tracking on the board',
    },
  },
  HYBRID: {
    title: 'Hybrid',
    tagline: 'Baseline + rolling wave',
    summary: 'Protects fixed commitments with a formal baseline while adapting detailed scope by iteration.',
    rigor: 'Standard+ rigor',
    controls: {
      'Planning horizon': 'Milestone baseline + iteration detail',
      'Requirement control': 'Backlog + formal baseline approval',
      'Change control': 'CR when impact exceeds threshold',
      'Customer decisions': 'Regular checkpoint',
      'Risk review': 'Weekly dependency review',
    },
  },
  ITERATIVE: {
    title: 'Iterative / Incremental',
    tagline: 'Progressive elaboration',
    summary: 'Delivers in successive increments, each refining scope and design based on the previous increment.',
    rigor: 'Standard rigor',
    controls: {
      'Planning horizon': 'Increment-by-increment planning',
      'Requirement control': 'Refined each increment',
      'Change control': 'Change assessed at increment boundary',
      'Customer decisions': 'Review at each increment',
      'Risk review': 'Increment retrospective',
    },
  },
  STAGE_GATE: {
    title: 'Predictive / Stage-Gate',
    tagline: 'Gated go/no-go decisions',
    summary: 'Formal gate reviews between stages, each requiring explicit go/no-go approval before proceeding.',
    rigor: 'Formal rigor',
    controls: {
      'Planning horizon': 'Stage-by-stage baseline',
      'Requirement control': 'Locked per stage',
      'Change control': 'Gate review board',
      'Customer decisions': 'Go/no-go at each gate',
      'Risk review': 'Gate risk assessment',
    },
  },
};

export const GENERIC_GOVERNANCE_MODEL_META: GovernanceModelMeta = {
  title: 'Custom model',
  tagline: 'AI-proposed governance model',
  summary: 'The AI proposed this model from project evidence — it is not one of the default six.',
  rigor: 'Custom rigor',
  controls: {},
};

export function governanceModelMeta(code: string): GovernanceModelMeta {
  return GOVERNANCE_MODEL_META[code as GovernanceModelCode] ?? { ...GENERIC_GOVERNANCE_MODEL_META, title: titleCase(code) };
}

function titleCase(code: string): string {
  return code
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * The six artifacts required for every project regardless of governance model (see
 * data/document-catalog.ts, which seeds these into DocumentDefinition for every project
 * type). Only their internal structure changes by model — this is Skill 2's mapping table.
 */
export const GOVERNANCE_ARTIFACT_NAMES = [
  'Project Charter',
  'Organization Chart',
  'RACI Matrix',
  'Communication Plan',
  'Change / Escalation Flow',
  'Risk Plan',
] as const;

export type GovernanceArtifactName = (typeof GOVERNANCE_ARTIFACT_NAMES)[number];

const GENERIC_ARTIFACT_GUIDANCE = 'Structure this using standard PM practice for the stated governance model; keep it consistent with the other five governance artifacts for this project.';

/** One short structural instruction per artifact × default model — fed into the Skill 2 prompt. */
export const GOVERNANCE_ARTIFACT_GUIDANCE: Record<GovernanceArtifactName, Partial<Record<GovernanceModelCode, string>>> = {
  'Project Charter': {
    WATERFALL: 'Organize by phase/milestone with a fixed scope statement and a sign-off line for each phase.',
    SCRUM: 'Lead with the Vision and Product Goal; do not lock scope — reference the backlog as the source of truth instead.',
    KANBAN: 'State the vision and the service delivery cadence; there is no fixed "end" — describe steady-state flow instead.',
    HYBRID: 'Combine a phase-based charter for fixed commitments with sprint-level detail called out per phase.',
    ITERATIVE: 'State the vision and the increment plan; each increment restates what it will refine from the last.',
    STAGE_GATE: 'Organize by stage with an explicit go/no-go decision criterion required to exit each stage.',
  },
  'Organization Chart': {
    WATERFALL: 'Structure by function/department; the PM is the single point of control.',
    SCRUM: 'Use Scrum roles: Product Owner, Scrum Master, Development Team; note if the PM plays one of these roles.',
    KANBAN: 'Structure around the continuous-flow team; there may be a Flow Manager instead of a fixed PM role.',
    HYBRID: 'Combine a functional/departmental structure with Agile sub-teams nested under each function.',
    ITERATIVE: 'Structure by function with a delivery lead per increment cycle.',
    STAGE_GATE: 'Structure by function/department with a named gatekeeper accountable for each stage exit.',
  },
  'RACI Matrix': {
    WATERFALL: 'One row per deliverable/milestone in the work breakdown structure.',
    SCRUM: 'One row per Scrum ceremony and artifact (who is R/A for the Backlog, Sprint Review, etc.).',
    KANBAN: 'One row per class-of-service and board column/policy.',
    HYBRID: 'Two layers: phase-level rows (Waterfall-style) plus iteration-level rows (Agile-style).',
    ITERATIVE: 'One row per increment activity (planning, build, review) repeated per increment.',
    STAGE_GATE: 'One row per stage plus one row for each gate-review decision.',
  },
  'Communication Plan': {
    WATERFALL: 'Organize by milestone reporting; low frequency, formal written reports.',
    SCRUM: 'Organize by Scrum ceremony cadence (Daily, Sprint Review, Retrospective).',
    KANBAN: 'Organize by continuous cadence (standup, board review) rather than fixed meeting dates.',
    HYBRID: 'Combine formal phase reporting with sprint-ceremony-style updates within each phase.',
    ITERATIVE: 'Organize by increment: a kickoff and a review/demo communication per increment.',
    STAGE_GATE: 'Organize by stage, with a formal gate-review communication at every stage boundary.',
  },
  'Change / Escalation Flow': {
    WATERFALL: 'Formal Change Control Board; every change request follows a phase-gated approval path.',
    SCRUM: 'Backlog reprioritization through the Product Owner; minimal formal change-request paperwork.',
    KANBAN: 'Flexible adjustment through WIP limits and board policy rather than a change board.',
    HYBRID: 'Small changes flow through the Agile team; changes affecting a phase baseline go through a Change Control Board.',
    ITERATIVE: 'Changes are assessed and queued at increment boundaries rather than mid-increment.',
    STAGE_GATE: 'Changes are only accepted at a gate review; mid-stage changes require an exception approval.',
  },
  'Risk Plan': {
    WATERFALL: 'A fixed Risk Register reviewed at each phase/gate.',
    SCRUM: 'Risk is surfaced and handled continuously in Sprint Planning and Retrospective.',
    KANBAN: 'Risk is tracked as blockers/blocked items directly on the board.',
    HYBRID: 'Two tiers: formal phase-level risks plus lighter, continuously-updated iteration-level risks.',
    ITERATIVE: 'Risk is reassessed at the start of every increment based on what the previous increment learned.',
    STAGE_GATE: 'Risk is formally assessed as part of every gate-review decision package.',
  },
};

export function artifactGuidance(name: string, model: string): string {
  const byArtifact = GOVERNANCE_ARTIFACT_GUIDANCE[name as GovernanceArtifactName];
  return byArtifact?.[model as GovernanceModelCode] ?? GENERIC_ARTIFACT_GUIDANCE;
}

export function isGovernanceArtifact(name: string): name is GovernanceArtifactName {
  return (GOVERNANCE_ARTIFACT_NAMES as readonly string[]).includes(name);
}
