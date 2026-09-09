import { ManagementDomain, ProjectType, Requirement } from '@prisma/client';

export interface CatalogEntry {
  name: string;
  requirement: Requirement;
  conditionKey?: string;
}

/** Domain document catalog per project type — mirrors `projectRules[type].domains`. */
export const DOCUMENT_CATALOG: Record<ProjectType, Record<ManagementDomain, CatalogEntry[]>> = {
  SI: {
    GOVERNANCE: [
      { name: 'Project Charter', requirement: 'REQUIRED' },
      { name: 'PM Operating Model', requirement: 'REQUIRED' },
      { name: 'Change & Decision Log', requirement: 'REQUIRED' },
      { name: 'Change / Escalation Flow', requirement: 'REQUIRED' },
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
      { name: 'Communication Management Plan', requirement: 'REQUIRED' },
      { name: 'Communication Plan', requirement: 'REQUIRED' },
    ],
    RESOURCES: [
      { name: 'Resource Management Plan', requirement: 'REQUIRED' },
      { name: 'RACI Matrix', requirement: 'REQUIRED' },
      { name: 'Handoff & Capability Plan', requirement: 'REQUIRED' },
      { name: 'Organization Chart', requirement: 'REQUIRED' },
    ],
    RISK: [
      { name: 'Risk Management Plan', requirement: 'REQUIRED' },
      { name: 'Risk & Dependency Register', requirement: 'REQUIRED' },
      { name: 'Integration Contingency Plan', requirement: 'CONDITIONAL', conditionKey: 'integrationComplexity=High — 3 external systems' },
      { name: 'Risk Plan', requirement: 'REQUIRED' },
    ],
  },
  SM: {
    GOVERNANCE: [
      { name: 'Service Management Charter', requirement: 'REQUIRED' },
      { name: 'Service Operating Model', requirement: 'REQUIRED' },
      { name: 'Change Governance Plan', requirement: 'REQUIRED' },
      { name: 'Project Charter', requirement: 'REQUIRED' },
      { name: 'Change / Escalation Flow', requirement: 'REQUIRED' },
    ],
    SCOPE: [
      { name: 'Service Scope & Catalogue', requirement: 'REQUIRED' },
      { name: 'SLA / OLA Management Plan', requirement: 'REQUIRED' },
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
      { name: 'Service Communication Plan', requirement: 'REQUIRED' },
      { name: 'Service Reporting Plan', requirement: 'REQUIRED' },
      { name: 'Communication Plan', requirement: 'REQUIRED' },
    ],
    RESOURCES: [
      { name: 'Support Organization & RACI', requirement: 'REQUIRED' },
      { name: 'Skills & Capacity Plan', requirement: 'REQUIRED' },
      { name: 'Knowledge Transfer Plan', requirement: 'REQUIRED' },
      { name: 'RACI Matrix', requirement: 'REQUIRED' },
      { name: 'Organization Chart', requirement: 'REQUIRED' },
    ],
    RISK: [
      { name: 'Operational Risk Plan', requirement: 'REQUIRED' },
      { name: 'Business Continuity & DR Plan', requirement: 'CONDITIONAL', conditionKey: 'continuityRequirement=DR required' },
      { name: 'Vendor Dependency Plan', requirement: 'CONDITIONAL' },
      { name: 'Risk Plan', requirement: 'REQUIRED' },
    ],
  },
  PRODUCT: {
    GOVERNANCE: [
      { name: 'Product Charter', requirement: 'REQUIRED' },
      { name: 'Product Operating Model', requirement: 'REQUIRED' },
      { name: 'Decision & Assumption Log', requirement: 'REQUIRED' },
      { name: 'Project Charter', requirement: 'REQUIRED' },
      { name: 'Change / Escalation Flow', requirement: 'REQUIRED' },
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
      { name: 'Communication Plan', requirement: 'REQUIRED' },
    ],
    RESOURCES: [
      { name: 'Product Team Charter', requirement: 'REQUIRED' },
      { name: 'Roles & Decision Rights', requirement: 'REQUIRED' },
      { name: 'Capability Plan', requirement: 'CONDITIONAL' },
      { name: 'RACI Matrix', requirement: 'REQUIRED' },
      { name: 'Organization Chart', requirement: 'REQUIRED' },
    ],
    RISK: [
      { name: 'Risk & Assumption Plan', requirement: 'REQUIRED' },
      { name: 'Experiment Register', requirement: 'REQUIRED' },
      { name: 'Release Risk Plan', requirement: 'CONDITIONAL' },
      { name: 'Risk Plan', requirement: 'REQUIRED' },
    ],
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
