/**
 * The default governance model list the AI scores against (instruction.md "Supported
 * Governance Models"). The AI may propose another model when project evidence clearly
 * calls for it (e.g. PRINCE2, Lean) — GOVERNANCE_MODEL_META and GOVERNANCE_ARTIFACT_GUIDANCE
 * fall back to a generic entry for any code not in this list, so nothing breaks.
 */
export const DEFAULT_GOVERNANCE_MODELS = [
  'WATERFALL',
  'SCRUM',
  'KANBAN',
  'HYBRID',
  'ITERATIVE',
  'STAGE_GATE',
  // Scored like the rest but only ever recommended for multi-team work — see `SAFE` in the meta
  // table below and the scale rule in the scoring prompt.
  'SAFE',
] as const;

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
  /**
   * Scaled Agile, and it is **conditional on scale** — the methodology skill admits it only for
   * genuinely multi-team work. A single team running SAFe carries the ceremony of an Agile Release
   * Train with nothing to coordinate, which is worse than Scrum on every axis, so the scoring prompt
   * is told to score it low rather than treat it as one more option.
   */
  SAFE: {
    title: 'SAFe / Scaled Agile',
    tagline: 'Multi-team agile at scale',
    summary:
      'Coordinates several agile teams on one cadence through an Agile Release Train — for multi-team programmes only; on a single team its overhead buys nothing.',
    rigor: 'Standard+ rigor',
    controls: {
      'Planning horizon': 'PI planning every 8-12 weeks',
      'Requirement control': 'Program backlog + team backlogs',
      'Change control': 'Re-prioritised at the PI boundary',
      'Customer decisions': 'System demo each iteration',
      'Risk review': 'ROAM at PI planning and Inspect & Adapt',
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
  // PMI Lexicon, and the same name in all three project types.
  'Communications Management Plan',
  // Was "Change / Escalation Flow": one document trying to be both the change-control process and
  // the escalation path. Change control belongs to the Change Management Plan; this is the path.
  'Issue Escalation Procedure',
  // Named "Risk Plan" until the RISK domain was cut to a single document. It absorbed the separate
  // per-type risk documents (register, contingency plan, operational/assumption plan), so it now
  // carries the name PMs actually use. The mandated-artifact rule is unchanged: still six.
  'Risk Management Plan',
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
    SAFE: 'Lead with the portfolio/programme vision and the Agile Release Train it runs on; scope is held as a program backlog and committed one Program Increment at a time, never for the whole engagement.',
  },
  'Organization Chart': {
    WATERFALL: 'Structure by function/department; the PM is the single point of control.',
    SCRUM: 'Use Scrum roles: Product Owner, Scrum Master, Development Team; note if the PM plays one of these roles.',
    KANBAN: 'Structure around the continuous-flow team; there may be a Flow Manager instead of a fixed PM role.',
    HYBRID: 'Combine a functional/departmental structure with Agile sub-teams nested under each function.',
    ITERATIVE: 'Structure by function with a delivery lead per increment cycle.',
    STAGE_GATE: 'Structure by function/department with a named gatekeeper accountable for each stage exit.',
    SAFE: 'One column per agile team on the train, plus the train-level roles above them — Release Train Engineer, Product Management, System Architect — so the coordination layer is visible and not implied.',
  },
  'RACI Matrix': {
    WATERFALL: 'One row per deliverable/milestone in the work breakdown structure.',
    SCRUM: 'One row per Scrum ceremony and artifact (who is R/A for the Backlog, Sprint Review, etc.).',
    KANBAN: 'One row per class-of-service and board column/policy.',
    HYBRID: 'Two layers: phase-level rows (Waterfall-style) plus iteration-level rows (Agile-style).',
    ITERATIVE: 'One row per increment activity (planning, build, review) repeated per increment.',
    STAGE_GATE: 'One row per stage plus one row for each gate-review decision.',
    SAFE: 'Two layers: train-level rows (PI planning, System Demo, Inspect & Adapt) and team-level rows beneath them, so it is clear which decisions belong to the train and which to a team.',
  },
  'Communications Management Plan': {
    WATERFALL: 'Organize by milestone reporting; low frequency, formal written reports.',
    SCRUM: 'Organize by Scrum ceremony cadence (Daily, Sprint Review, Retrospective).',
    KANBAN: 'Organize by continuous cadence (standup, board review) rather than fixed meeting dates.',
    HYBRID: 'Combine formal phase reporting with sprint-ceremony-style updates within each phase.',
    ITERATIVE: 'Organize by increment: a kickoff and a review/demo communication per increment.',
    STAGE_GATE: 'Organize by stage, with a formal gate-review communication at every stage boundary.',
    SAFE: 'Organize by the train cadence: PI planning, the System Demo each iteration, and Inspect & Adapt at the PI boundary — plus how the teams sync between them (Scrum of Scrums, PO sync).',
  },
  'Issue Escalation Procedure': {
    WATERFALL: 'Formal tiers with named authorities at each level and a documented response time per tier.',
    SCRUM: 'The team resolves what it can within the Sprint; impediments the Scrum Master cannot clear go to the Product Owner, then to the sponsor.',
    KANBAN: 'Escalate on blocked-item age and WIP-limit breach rather than on a meeting calendar.',
    HYBRID: 'Iteration-level issues are cleared by the team; anything touching a phase baseline escalates to the steering body.',
    ITERATIVE: 'Issues are triaged within the increment; those that cannot be absorbed escalate at the increment boundary.',
    STAGE_GATE: 'Escalate to the gate authority; an issue that cannot wait for the gate needs an explicit exception approval.',
    SAFE: 'The team clears what it can in the iteration; what it cannot goes to the Scrum of Scrums, then to the Release Train Engineer, then to programme stakeholders — say which impediments each level owns.',
  },
  'Risk Management Plan': {
    WATERFALL: 'A fixed Risk Register reviewed at each phase/gate.',
    SCRUM: 'Risk is surfaced and handled continuously in Sprint Planning and Retrospective.',
    KANBAN: 'Risk is tracked as blockers/blocked items directly on the board.',
    HYBRID: 'Two tiers: formal phase-level risks plus lighter, continuously-updated iteration-level risks.',
    ITERATIVE: 'Risk is reassessed at the start of every increment based on what the previous increment learned.',
    STAGE_GATE: 'Risk is formally assessed as part of every gate-review decision package.',
    SAFE: 'Risks are ROAMed at PI planning — Resolved, Owned, Accepted or Mitigated — and reviewed again at Inspect & Adapt; cross-team dependencies are the ones that belong at train level.',
  },
};

export function artifactGuidance(name: string, model: string): string {
  const byArtifact = GOVERNANCE_ARTIFACT_GUIDANCE[name as GovernanceArtifactName];
  return byArtifact?.[model as GovernanceModelCode] ?? GENERIC_ARTIFACT_GUIDANCE;
}

export function isGovernanceArtifact(name: string): name is GovernanceArtifactName {
  return (GOVERNANCE_ARTIFACT_NAMES as readonly string[]).includes(name);
}
