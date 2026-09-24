import { ManagementDomain, ProjectType, Requirement } from '@prisma/client';

export interface CatalogEntry {
  name: string;
  requirement: Requirement;
  conditionKey?: string;
}

/**
 * The one catalog document that is produced by **filling the customer's own file** rather than by
 * drafting prose. When the project's customer has a template of this `documentType` in the
 * reference library, generating it fills that deck in place — their layout, masters, fonts and
 * images survive — and the blanks it cannot answer become ordinary `{{gap:N}}` questions for the
 * PM. A customer without a template gets the same content as a branded Word document instead.
 *
 * The string is shared with `CustomerTemplate.documentType`, which is what ties the two together.
 */
export const KICKOFF_DECK = 'Kickoff Deck';

/**
 * The Project Plan workbook is **no longer generated**, and this name is kept only so nothing that
 * still refers to it breaks.
 *
 * It was produced by filling the house template `Template_Project Plan_v4.2.xlsx` — 281 blanks
 * across 16 sheets. In practice the model could ground only a handful of them from project data
 * and correctly left the rest as the template's own worked examples, so a generation cost six
 * model calls and returned something close to the blank template. The PM filling that workbook by
 * hand is both cheaper and better, so the catalog no longer offers it.
 *
 * The template itself stays in the customer library, downloadable, and
 * `customerTemplatesForProject` still resolves it — restoring the feature means putting the
 * `PROJECT_PLAN` entries back in the catalog below and re-seeding. Nothing else was removed.
 */
export const PROJECT_PLAN = 'Project Plan';

/** Domain document catalog per project type — mirrors `projectRules[type].domains`. */
export const DOCUMENT_CATALOG: Record<ProjectType, Record<ManagementDomain, CatalogEntry[]>> = {
  SI: {
    GOVERNANCE: [
      { name: 'Project Charter', requirement: 'REQUIRED' },
      { name: 'PM Operating Model', requirement: 'REQUIRED' },
      /**
       * One log, three kinds of entry. SI called it "Change & Decision Log" and Product called it
       * "Decision & Assumption Log" — two names for one register, each merging a different arbitrary
       * pair of the three things a governance log records. The register's own `Type` column is what
       * separates a change from a decision from an assumption, so one document does the work and a
       * PM looking for "the decision log" finds it under that name in every project type.
       */
      { name: 'Decision Log', requirement: 'REQUIRED' },
      // Was "Change / Escalation Flow", which read as a second change-management document beside
      // the change plan. It is the escalation path and nothing else, so it says that.
      { name: 'Issue Escalation Procedure', requirement: 'REQUIRED' },
    ],
    SCOPE: [
      { name: 'Scope Management Plan', requirement: 'REQUIRED' },
      { name: 'Requirements Management Plan', requirement: 'REQUIRED' },
      { name: 'WBS & Integration Boundary', requirement: 'REQUIRED' },
    ],
    SCHEDULE: [
      { name: 'Schedule Management Plan', requirement: 'REQUIRED' },
      { name: 'Project Schedule & Milestones', requirement: 'REQUIRED' },
      { name: 'Cutover Roadmap', requirement: 'CONDITIONAL', conditionKey: 'acceptanceModel=Milestone + customer sign-off' },
    ],
    FINANCE: [
      { name: 'Cost Management Plan', requirement: 'CONDITIONAL', conditionKey: 'budgetControlScope=PM owns' },
      { name: 'Cost Baseline', requirement: 'CONDITIONAL', conditionKey: 'budgetControlScope=PM owns' },
      { name: 'Commercial Change Log', requirement: 'REQUIRED' },
    ],
    STAKEHOLDERS: [
      { name: 'Stakeholder Register', requirement: 'REQUIRED' },
      { name: 'Stakeholder Engagement Plan', requirement: 'REQUIRED' },
      // "Communication Management Plan" used to sit here next to "Communication Plan" — two
      // documents for one subject, which only ever produced two overlapping drafts to review. The
      // survivor now carries the PMI Lexicon name, the same one in all three project types.
      { name: 'Communications Management Plan', requirement: 'REQUIRED' },
    ],
    // PROJECT_PLAN intentionally holds no documents — see the note on `PROJECT_PLAN` above.
    PROJECT_PLAN: [],
    KICKOFF: [{ name: KICKOFF_DECK, requirement: 'REQUIRED' }],
    RESOURCES: [
      { name: 'Resource Management Plan', requirement: 'REQUIRED' },
      { name: 'RACI Matrix', requirement: 'REQUIRED' },
      { name: 'Handoff & Capability Plan', requirement: 'REQUIRED' },
      { name: 'Organization Chart', requirement: 'REQUIRED' },
    ],
    // One risk document, not four. The register, the contingency plan and the separate governance
    // "Risk Plan" all restated the same material; the mandated artifact now carries it, which is
    // why it is named "Risk Management Plan" in GOVERNANCE_ARTIFACT_NAMES.
    RISK: [{ name: 'Risk Management Plan', requirement: 'REQUIRED' }],
  },
  SM: {
    GOVERNANCE: [
      /**
       * One charter per project, and it is the Project Charter.
       *
       * "Service Management Charter" sat here beside it saying the same thing — why this engagement
       * exists, who sponsors it, what authority the manager has — so every SM project produced two
       * documents with one subject and a PM had to read both to find out which was authoritative.
       * `Service Operating Model` below already carries how the service is run, which is the part a
       * service charter adds over a project charter.
       */
      { name: 'Project Charter', requirement: 'REQUIRED' },
      { name: 'Service Operating Model', requirement: 'REQUIRED' },
      // PMI Lexicon. "Change Governance Plan" was this project's own coinage for a document every
      // PM already knows by its standard name.
      { name: 'Change Management Plan', requirement: 'REQUIRED' },
      { name: 'Decision Log', requirement: 'REQUIRED' },
      { name: 'Issue Escalation Procedure', requirement: 'REQUIRED' },
      // Moved from SCOPE. An SLA is the governing agreement for the service — what is promised and
      // what happens when it is missed — not a statement of what work is in or out.
      { name: 'SLA / OLA Management Plan', requirement: 'REQUIRED' },
    ],
    SCOPE: [
      { name: 'Service Scope & Catalogue', requirement: 'REQUIRED' },
      { name: 'Maintenance Backlog Approach', requirement: 'CONDITIONAL', conditionKey: 'ticketVariability=High seasonal variation' },
    ],
    SCHEDULE: [
      { name: 'Service Transition Plan', requirement: 'REQUIRED' },
      { name: 'Release & Maintenance Calendar', requirement: 'REQUIRED' },
      { name: 'Shift / On-call Schedule', requirement: 'CONDITIONAL', conditionKey: 'supportCoverage=24×7 tiered support' },
    ],
    FINANCE: [
      { name: 'Service Cost Plan', requirement: 'CONDITIONAL', conditionKey: 'budgetControlScope=PM owns' },
      { name: 'Consumption & Capacity Forecast', requirement: 'CONDITIONAL' },
      { name: 'Commercial Change Log', requirement: 'REQUIRED' },
    ],
    STAKEHOLDERS: [
      { name: 'Stakeholder Register', requirement: 'REQUIRED' },
      /**
       * "Service Communication Plan" and "Communication Plan" were the same document twice, which
       * renaming to the PMI name would only have made more obvious. `Service Reporting Plan` below
       * is genuinely different — it is the service's reporting pack and cadence, not who is told
       * what — so it stays.
       */
      { name: 'Communications Management Plan', requirement: 'REQUIRED' },
      { name: 'Service Reporting Plan', requirement: 'REQUIRED' },
    ],
    // PROJECT_PLAN intentionally holds no documents — see the note on `PROJECT_PLAN` above.
    PROJECT_PLAN: [],
    KICKOFF: [{ name: KICKOFF_DECK, requirement: 'REQUIRED' }],
    RESOURCES: [
      /**
       * "Support Organization & RACI" carried a RACI beside the `RACI Matrix` below, and its
       * organisation half is `Organization Chart`. SI and Product already have exactly one RACI and
       * one chart; SM now matches them.
       */
      { name: 'RACI Matrix', requirement: 'REQUIRED' },
      { name: 'Organization Chart', requirement: 'REQUIRED' },
      { name: 'Skills & Capacity Plan', requirement: 'REQUIRED' },
      { name: 'Knowledge Transfer Plan', requirement: 'REQUIRED' },
    ],
    RISK: [{ name: 'Risk Management Plan', requirement: 'REQUIRED' }],
  },
  PRODUCT: {
    GOVERNANCE: [
      // "Product Charter" and "Project Charter" were the same document twice, exactly as in SM.
      // `Product Operating Model` carries what a product charter adds over a project charter.
      { name: 'Project Charter', requirement: 'REQUIRED' },
      { name: 'Product Operating Model', requirement: 'REQUIRED' },
      { name: 'Decision Log', requirement: 'REQUIRED' },
      { name: 'Issue Escalation Procedure', requirement: 'REQUIRED' },
    ],
    SCOPE: [
      { name: 'Product Vision & Scope', requirement: 'REQUIRED' },
      { name: 'Backlog Management Approach', requirement: 'REQUIRED' },
      { name: 'Definition of Ready / Done', requirement: 'REQUIRED' },
    ],
    SCHEDULE: [
      { name: 'Outcome Roadmap', requirement: 'REQUIRED' },
      { name: 'Release Plan', requirement: 'REQUIRED' },
      { name: 'Iteration Cadence', requirement: 'REQUIRED' },
    ],
    FINANCE: [
      { name: 'Budget Guardrails', requirement: 'CONDITIONAL' },
      { name: 'Value Forecast', requirement: 'CONDITIONAL' },
      { name: 'Funding Review Plan', requirement: 'CONDITIONAL' },
    ],
    STAKEHOLDERS: [
      { name: 'Stakeholder Register', requirement: 'REQUIRED' },
      { name: 'Discovery & Feedback Plan', requirement: 'REQUIRED' },
      { name: 'Communications Management Plan', requirement: 'REQUIRED' },
    ],
    // PROJECT_PLAN intentionally holds no documents — see the note on `PROJECT_PLAN` above.
    PROJECT_PLAN: [],
    KICKOFF: [{ name: KICKOFF_DECK, requirement: 'REQUIRED' }],
    RESOURCES: [
      // Not a third "Charter". It is what the team agrees about how it works together, and calling
      // it that stops it being mistaken for the document that authorises the project.
      { name: 'Product Team Working Agreement', requirement: 'REQUIRED' },
      { name: 'Roles & Decision Rights', requirement: 'REQUIRED' },
      { name: 'Capability Plan', requirement: 'CONDITIONAL' },
      { name: 'RACI Matrix', requirement: 'REQUIRED' },
      { name: 'Organization Chart', requirement: 'REQUIRED' },
    ],
    RISK: [{ name: 'Risk Management Plan', requirement: 'REQUIRED' }],
  },
};

export interface SectionSeed {
  title: string;
  hint?: string;
  required?: boolean;
  defaultIncluded?: boolean;
}

/** The third "delivery" template differs per project type. */
export const DELIVERY_TEMPLATE: Record<ProjectType, { name: string; subtitle: string; description: string; sections: SectionSeed[] }> = {
  SI: {
    name: 'SI Delivery',
    subtitle: 'Integration-focused',
    description: 'Adds system interfaces, acceptance gates, cutover and handover.',
    sections: [
      { title: 'Purpose & success criteria', required: true },
      { title: 'Integration scope & boundaries', hint: 'Includes SI integration boundary', required: true },
      { title: 'Milestones & acceptance gates', hint: 'Mapped to Schedule domain' },
      { title: 'Dependencies & interface owners', hint: 'Cross-linked to Risk domain' },
      { title: 'Cutover, handover & warranty' },
    ],
  },
  SM: {
    name: 'SM Operations',
    subtitle: 'Service-continuity focused',
    description: 'Adds SLA, transition, incident, change and support handover controls.',
    sections: [
      { title: 'Service objectives & outcomes', required: true },
      { title: 'Service scope & exclusions', required: true },
      { title: 'SLA, OLA & measurement' },
      { title: 'Support model & escalation' },
      { title: 'Transition, continuity & reporting' },
    ],
  },
  PRODUCT: {
    name: 'Product Adaptive',
    subtitle: 'Discovery & release focused',
    description: 'Adds outcomes, experiments, roadmap, backlog and release learning loops.',
    sections: [
      { title: 'Product vision & outcomes', required: true },
      { title: 'Users, problems & hypotheses', required: true },
      { title: 'Roadmap & release goals' },
      { title: 'Backlog and prioritization rules' },
      { title: 'Experiments, metrics & learning cadence' },
    ],
  },
};

/** Standard and Lean structures are shared across documents; delivery is type-specific. */
export const BASE_TEMPLATES = {
  standard: {
    name: 'Standard',
    subtitle: 'Balanced governance',
    description: 'Complete structure for a medium-to-large project.',
    recommended: true,
    fitScore: 94,
    sections: [
      { title: 'Project purpose & business case', hint: 'Required by template rule', required: true },
      { title: 'Measurable objectives & success criteria', hint: 'Generated from verified project inputs' },
      { title: 'High-level scope & exclusions', hint: 'Includes integration boundary' },
      { title: 'Milestone & acceptance summary', hint: 'Mapped to Schedule domain' },
      { title: 'Key risks, assumptions & dependencies', hint: 'Cross-linked to Risk domain' },
      { title: 'Detailed financial authorization', hint: 'Conditional · customer owns budget', defaultIncluded: false },
    ] as SectionSeed[],
  },
  lean: {
    name: 'Lean',
    subtitle: 'Essential sections',
    description: 'Condensed setup for a small, low-risk project.',
    recommended: false,
    fitScore: 71,
    sections: [
      { title: 'Purpose & objectives', required: true },
      { title: 'Scope boundaries' },
      { title: 'Key milestones' },
      { title: 'Owner & approvals' },
    ] as SectionSeed[],
  },
};
