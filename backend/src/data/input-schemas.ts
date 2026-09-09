import { FieldType, ManagementDomain, ProjectType } from '@prisma/client';

export interface FieldSeed {
  key: string;
  label: string;
  fieldType: FieldType;
  options?: string[];
  domain: ManagementDomain;
  /** Signal consumed by the governance-model recommendation prompt (see modules/ai/provider.ts). */
  signalKey?: string;
  required?: boolean;
  defaultValue?: string;
}

/**
 * "Minimum project profile" — the 12 required signals per project type.
 * Mirrors `inputSchemas` in the approved prototype.
 */
export const INPUT_SCHEMAS: Record<ProjectType, FieldSeed[]> = {
  SI: [
    { key: 'projectName', label: 'Project name', fieldType: FieldType.TEXT, domain: ManagementDomain.GOVERNANCE, defaultValue: 'KR Commerce Modernization' },
    { key: 'businessObjective', label: 'Business objective', fieldType: FieldType.TEXT, domain: ManagementDomain.SCOPE, defaultValue: 'Launch a unified B2B commerce platform' },
    { key: 'successMeasure', label: 'Success measure', fieldType: FieldType.TEXT, domain: ManagementDomain.SCOPE, defaultValue: 'Launch by Mar 31; order error below 1%' },
    { key: 'targetWindow', label: 'Target dates', fieldType: FieldType.DATE_RANGE, domain: ManagementDomain.SCHEDULE, defaultValue: '2026-10-01..2027-03-31' },
    { key: 'contractModel', label: 'Contract model', fieldType: FieldType.SELECT, options: ['Fixed price', 'Time & Materials', 'Internal initiative'], domain: ManagementDomain.FINANCE, signalKey: 'contractModel', defaultValue: 'Fixed price' },
    { key: 'deadlineFlexibility', label: 'Deadline flexibility', fieldType: FieldType.SELECT, options: ['Fixed launch date', 'Negotiable', 'Flexible'], domain: ManagementDomain.SCHEDULE, signalKey: 'deadlineFlexibility', defaultValue: 'Fixed launch date' },
    { key: 'scopeClarity', label: 'Scope clarity', fieldType: FieldType.SELECT, options: ['Medium — major flows known', 'High — stable and detailed', 'Low — discovery required'], domain: ManagementDomain.SCOPE, signalKey: 'scopeClarity', defaultValue: 'Medium — major flows known' },
    { key: 'requirementVolatility', label: 'Requirement volatility', fieldType: FieldType.SELECT, options: ['High', 'Medium', 'Low'], domain: ManagementDomain.SCOPE, signalKey: 'requirementVolatility', defaultValue: 'High' },
    { key: 'deliverySetup', label: 'Delivery setup', fieldType: FieldType.SELECT, options: ['Korea onsite + Vietnam offshore', 'Full offshore', 'Co-located'], domain: ManagementDomain.RESOURCES, signalKey: 'deliverySetup', defaultValue: 'Korea onsite + Vietnam offshore' },
    { key: 'integrationComplexity', label: 'Integration complexity', fieldType: FieldType.SELECT, options: ['High — 3 external systems', 'Medium', 'Low'], domain: ManagementDomain.RISK, signalKey: 'integrationComplexity', defaultValue: 'High — 3 external systems' },
    { key: 'acceptanceModel', label: 'Acceptance model', fieldType: FieldType.SELECT, options: ['Milestone + customer sign-off', 'Increment acceptance', 'Internal acceptance'], domain: ManagementDomain.GOVERNANCE, signalKey: 'acceptanceModel', defaultValue: 'Milestone + customer sign-off' },
    { key: 'complianceNeed', label: 'Compliance need', fieldType: FieldType.SELECT, options: ['Medium', 'High', 'Low'], domain: ManagementDomain.GOVERNANCE, signalKey: 'complianceNeed', defaultValue: 'Medium' },
    { key: 'customerDecisionSpeed', label: 'Customer decision speed', fieldType: FieldType.SELECT, options: ['Slow — 3–5 business days', 'Regular — 1–2 days', 'Embedded / same day'], domain: ManagementDomain.STAKEHOLDERS, signalKey: 'customerDecisionSpeed', defaultValue: 'Slow — 3–5 business days' },
    { key: 'releaseExpectation', label: 'Release expectation', fieldType: FieldType.SELECT, options: ['Increment every 2 weeks', 'Single final release', 'Monthly'], domain: ManagementDomain.SCHEDULE, signalKey: 'releaseExpectation', defaultValue: 'Increment every 2 weeks' },
    { key: 'escalationSla', label: 'Escalation SLA', fieldType: FieldType.SELECT, options: ['2 days', '3 days', '5 days'], domain: ManagementDomain.GOVERNANCE, signalKey: 'escalationSla' },
    { key: 'externalApiOwner', label: 'External API owner', fieldType: FieldType.TEXT, domain: ManagementDomain.RISK, signalKey: 'externalApiOwner' },
    { key: 'budgetControlScope', label: 'Budget control scope', fieldType: FieldType.SELECT, options: ['PM owns', 'Track impact only'], domain: ManagementDomain.FINANCE, signalKey: 'budgetControlScope' },
  ],
  SM: [
    { key: 'serviceName', label: 'Service name', fieldType: FieldType.TEXT, domain: ManagementDomain.GOVERNANCE, defaultValue: 'SK Manufacturing AMS' },
    { key: 'serviceObjective', label: 'Service objective', fieldType: FieldType.TEXT, domain: ManagementDomain.SCOPE, defaultValue: 'Keep production applications stable and available' },
    { key: 'successMeasure', label: 'Success measure', fieldType: FieldType.TEXT, domain: ManagementDomain.SCOPE, defaultValue: '99.9% SLA; P1 restore below 2 hours' },
    { key: 'serviceTerm', label: 'Service term', fieldType: FieldType.DATE_RANGE, domain: ManagementDomain.SCHEDULE, defaultValue: '2027-01-01..2027-12-31' },
    { key: 'contractModel', label: 'Contract model', fieldType: FieldType.SELECT, options: ['Managed service', 'T&M support', 'Outcome-based'], domain: ManagementDomain.FINANCE, signalKey: 'contractModel', defaultValue: 'Managed service' },
    { key: 'slaCriticality', label: 'SLA criticality', fieldType: FieldType.SELECT, options: ['Business critical', 'High', 'Standard'], domain: ManagementDomain.GOVERNANCE, signalKey: 'slaCriticality', defaultValue: 'Business critical' },
    { key: 'scopeClarity', label: 'Service scope clarity', fieldType: FieldType.SELECT, options: ['Defined service catalogue', 'Partial catalogue', 'Discovery required'], domain: ManagementDomain.SCOPE, signalKey: 'scopeClarity', defaultValue: 'Defined service catalogue' },
    { key: 'ticketVariability', label: 'Ticket variability', fieldType: FieldType.SELECT, options: ['High seasonal variation', 'Medium', 'Low'], domain: ManagementDomain.SCOPE, signalKey: 'ticketVariability', defaultValue: 'High seasonal variation' },
    { key: 'supportCoverage', label: 'Support coverage', fieldType: FieldType.SELECT, options: ['24×7 tiered support', '16×5', '8×5'], domain: ManagementDomain.RESOURCES, signalKey: 'supportCoverage', defaultValue: '24×7 tiered support' },
    { key: 'transitionComplexity', label: 'Transition complexity', fieldType: FieldType.SELECT, options: ['High — incumbent handover', 'Medium', 'Low'], domain: ManagementDomain.RISK, signalKey: 'transitionComplexity', defaultValue: 'High — incumbent handover' },
    { key: 'changeModel', label: 'Change model', fieldType: FieldType.SELECT, options: ['CAB-controlled releases', 'Team approval', 'Customer approval'], domain: ManagementDomain.GOVERNANCE, signalKey: 'changeModel', defaultValue: 'CAB-controlled releases' },
    { key: 'continuityRequirement', label: 'Continuity requirement', fieldType: FieldType.SELECT, options: ['DR required', 'Backup only', 'Standard recovery'], domain: ManagementDomain.RISK, signalKey: 'continuityRequirement', defaultValue: 'DR required' },
    { key: 'escalationSla', label: 'Escalation SLA', fieldType: FieldType.SELECT, options: ['2 days', '3 days', '5 days'], domain: ManagementDomain.GOVERNANCE, signalKey: 'escalationSla' },
    { key: 'budgetControlScope', label: 'Budget control scope', fieldType: FieldType.SELECT, options: ['PM owns', 'Track impact only'], domain: ManagementDomain.FINANCE, signalKey: 'budgetControlScope' },
  ],
  PRODUCT: [
    { key: 'productName', label: 'Product name', fieldType: FieldType.TEXT, domain: ManagementDomain.GOVERNANCE, defaultValue: 'AI Quality Assistant' },
    { key: 'productVision', label: 'Product vision', fieldType: FieldType.TEXT, domain: ManagementDomain.SCOPE, defaultValue: 'Reduce manual quality review effort with AI' },
    { key: 'targetOutcome', label: 'Target outcome', fieldType: FieldType.TEXT, domain: ManagementDomain.SCOPE, defaultValue: '30% faster review; pilot adoption above 70%' },
    { key: 'planningHorizon', label: 'Planning horizon', fieldType: FieldType.TEXT, domain: ManagementDomain.SCHEDULE, defaultValue: 'Q4 pilot — H1 scale' },
    { key: 'contractModel', label: 'Funding model', fieldType: FieldType.SELECT, options: ['Quarterly product funding', 'Fixed initiative budget', 'Experiment funding'], domain: ManagementDomain.FINANCE, signalKey: 'contractModel', defaultValue: 'Quarterly product funding' },
    { key: 'deadlineFlexibility', label: 'Market deadline', fieldType: FieldType.SELECT, options: ['Target window', 'Fixed event', 'Continuous delivery'], domain: ManagementDomain.SCHEDULE, signalKey: 'deadlineFlexibility', defaultValue: 'Target window' },
    { key: 'scopeClarity', label: 'Problem clarity', fieldType: FieldType.SELECT, options: ['Problem validated; solution uncertain', 'High', 'Low'], domain: ManagementDomain.SCOPE, signalKey: 'scopeClarity', defaultValue: 'Problem validated; solution uncertain' },
    { key: 'requirementVolatility', label: 'Discovery uncertainty', fieldType: FieldType.SELECT, options: ['High', 'Medium', 'Low'], domain: ManagementDomain.SCOPE, signalKey: 'requirementVolatility', defaultValue: 'High' },
    { key: 'deliverySetup', label: 'Product team setup', fieldType: FieldType.SELECT, options: ['Cross-functional stable team', 'Shared specialists', 'Vendor delivery'], domain: ManagementDomain.RESOURCES, signalKey: 'deliverySetup', defaultValue: 'Cross-functional stable team' },
    { key: 'releaseExpectation', label: 'Release cadence', fieldType: FieldType.SELECT, options: ['Every 2 weeks', 'Monthly', 'Continuous'], domain: ManagementDomain.SCHEDULE, signalKey: 'releaseExpectation', defaultValue: 'Every 2 weeks' },
    { key: 'customerDecisionSpeed', label: 'Feedback access', fieldType: FieldType.SELECT, options: ['Weekly user testing', 'Monthly review', 'Limited access'], domain: ManagementDomain.STAKEHOLDERS, signalKey: 'customerDecisionSpeed', defaultValue: 'Weekly user testing' },
    { key: 'complianceNeed', label: 'Regulatory need', fieldType: FieldType.SELECT, options: ['Medium', 'High', 'Low'], domain: ManagementDomain.GOVERNANCE, signalKey: 'complianceNeed', defaultValue: 'Medium' },
    { key: 'budgetControlScope', label: 'Budget control scope', fieldType: FieldType.SELECT, options: ['PM owns', 'Track impact only'], domain: ManagementDomain.FINANCE, signalKey: 'budgetControlScope' },
  ],
};

/** Reference upload groups shown on the input screen. */
export const REFERENCE_GROUPS = [
  { group: 'COMMITMENT', glyph: 'C', tone: 'navy', title: 'Commitment & contract', hint: 'SOW, proposal, RFP or contract excerpt' },
  { group: 'SCOPE', glyph: 'S', tone: 'cyan', title: 'Scope reference', hint: 'Requirement list, feature map or product brief' },
  { group: 'ORGANIZATION', glyph: 'O', tone: 'rose', title: 'Organization reference', hint: 'Team roster, stakeholder list or org chart' },
  { group: 'SCHEDULE', glyph: 'T', tone: 'violet', title: 'Schedule constraints', hint: 'Committed dates, launch calendar or estimate' },
] as const;
