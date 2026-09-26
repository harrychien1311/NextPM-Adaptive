/**
 * The Planning Assessment rule catalog — the FPT standard, as data.
 *
 * Every rule carries where it came from, when it applies, what it checks, and what the PM is told
 * when it fails. Adding or retiring a rule is an edit to this file and nothing else: the engine,
 * the four tabs, the readiness maths, the PM action center and the prompt are all driven from here,
 * so they cannot drift apart the way a rule copied into a prompt and into a screen always does.
 *
 * **Four categories, and the boundaries between them are the point.**
 *
 * | Category | Asks | Fails when |
 * | --- | --- | --- |
 * | `MISSING_INFORMATION` | is this *fact* known? | the project input does not state it |
 * | `MISSING_DOCUMENT` | does this *document* exist? | it applies to this project and the input does not provide it |
 * | `PLANNING_RISK` | does this combination *threaten delivery*? | a trigger condition holds |
 * | `CONFLICT` | do two sources *disagree*? | two pieces of evidence contradict |
 *
 * A missing fact is never a conflict — a conflict needs two sources that disagree, and absence is
 * only one. This is why `CONFLICT` rules all name evidence A and evidence B.
 *
 * **Every rule is judged by the model against the project input** — the PM's recorded answers and
 * the text of every uploaded document. Nothing is decided by checking whether a form field happens
 * to be non-empty: a field can hold "TBD" and a document can state a contract type the form never
 * asked for, and only reading the material tells those apart.
 *
 * **Missing Documents distinguishes two kinds of requirement**, and the screen shows them apart:
 *
 * - `appliesWhen: null` — required for **every** project (Contract, Charter, Plan, Schedule, Risk
 *   list...). It can only PASS or FAIL.
 * - `appliesWhen: "<condition>"` — required only in a **specific situation** (an AI project, a
 *   supplier-controlled delivery, translation scope). The model decides whether the situation holds,
 *   and answers NOT_APPLICABLE when it does not, so a project is never reported as missing an AI
 *   data plan it has no reason to have.
 *
 * `artifacts` lists what would satisfy an MD rule. It checks a capability, not a filename — a
 * Communication Plan often lives inside the Project Plan. The names that are catalog documents are
 * also how a failed rule is tied to the document Planning Documents generates to close it.
 *
 * Severity drives weight rather than each rule carrying an arbitrary number: a catalog of 147 hand-
 * tuned weights is a catalog nobody can keep coherent, and "how bad is this" is exactly what
 * severity already states.
 */

import type { ManagementDomain } from '@prisma/client';

export type AssessmentCategory = 'MISSING_INFORMATION' | 'MISSING_DOCUMENT' | 'PLANNING_RISK' | 'CONFLICT';

/** Per the methodology definition. `BLOCKER` means the assessment cannot be completed. */
export type RuleSeverity = 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/**
 * `UNKNOWN` is a first-class answer and must never be collapsed into `FAIL`. "We could not tell"
 * and "this is missing" lead the PM to different actions — one to upload a document, the other to
 * make a decision — and a screen that reports the first as the second sends them to do the wrong
 * one.
 */
export type RuleStatus = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE' | 'OVERRIDDEN';

export type Evaluation =
  /** A document or an equivalent section. Any one of `artifacts` satisfies it. */
  | { kind: 'ARTIFACT'; artifacts: string[] }
  /** A fact, a risk trigger or a contradiction, stated as the question the model answers. */
  | { kind: 'JUDGEMENT'; question: string };

export interface AssessmentRule {
  ruleId: string;
  name: string;
  assessmentCategory: AssessmentCategory;
  sourceType: 'QMS' | 'PROCESS';
  sourceDocument: string;
  sourceReference: string;
  /** Null means the rule applies to every project. */
  appliesWhen: string | null;
  evaluate: Evaluation;
  result: { severity: RuleSeverity; message: string; recommendedAction: string };
  mandatory: boolean;
  weight: number;
  targetTab: string;
  status: 'ACTIVE' | 'RETIRED';
  version: string;
}

/**
 * Severity → weight. A blocker counts five times what an advisory note counts, so the FPT standard
 * score moves most when the things that actually stop a project are closed.
 */
const WEIGHT: Record<RuleSeverity, number> = { BLOCKER: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };

const TAB: Record<AssessmentCategory, string> = {
  MISSING_INFORMATION: 'Missing Information',
  MISSING_DOCUMENT: 'Missing Documents',
  PLANNING_RISK: 'Risks',
  CONFLICT: 'Conflicts',
};

const CHECKLIST = 'Checklist_Project Planning Review_v4.7';
const PROCESS = 'Process_Software Project Management v5.0';

function make(
  category: AssessmentCategory,
  sourceDocument: string,
  sourceType: 'QMS' | 'PROCESS',
  ruleId: string,
  name: string,
  severity: RuleSeverity,
  message: string,
  recommendedAction: string,
  evaluate: Evaluation,
  appliesWhen: string | null = null,
): AssessmentRule {
  return {
    ruleId,
    name,
    assessmentCategory: category,
    sourceType,
    sourceDocument,
    sourceReference: ruleId,
    appliesWhen,
    evaluate,
    result: { severity, message, recommendedAction },
    // A blocker is exactly the set that must be answered before the assessment can be called
    // complete, so "mandatory" is not a second, separately maintained flag.
    mandatory: severity === 'BLOCKER',
    weight: WEIGHT[severity],
    targetTab: TAB[category],
    status: 'ACTIVE',
    version: '1.1',
  };
}

const mi = (
  id: string,
  name: string,
  sev: RuleSeverity,
  msg: string,
  action: string,
  question: string,
  appliesWhen: string | null = null,
) =>
  make('MISSING_INFORMATION', CHECKLIST, 'QMS', id, name, sev, msg, action, { kind: 'JUDGEMENT', question }, appliesWhen);

const md = (
  id: string,
  name: string,
  sev: RuleSeverity,
  msg: string,
  action: string,
  artifacts: string[],
  appliesWhen: string | null = null,
) =>
  make('MISSING_DOCUMENT', PROCESS, 'PROCESS', id, name, sev, msg, action, { kind: 'ARTIFACT', artifacts }, appliesWhen);

const rk = (
  id: string,
  name: string,
  sev: RuleSeverity,
  msg: string,
  action: string,
  trigger: string,
  appliesWhen: string | null = null,
) =>
  make('PLANNING_RISK', CHECKLIST, 'QMS', id, name, sev, msg, action, { kind: 'JUDGEMENT', question: trigger }, appliesWhen);

/**
 * A conflict rule always names both sides. The engine passes both to the model and requires it to
 * quote each one, because a "conflict" backed by a single quote is an assertion, not a finding.
 */
const cf = (id: string, name: string, a: string, b: string, conflict: string) =>
  make(
    'CONFLICT',
    CHECKLIST,
    'QMS',
    id,
    name,
    // Every conflict is HIGH. The methodology defines no conflict as a blocker, and inventing one
    // would stop projects completing their assessment for a reason nobody wrote down.
    'HIGH',
    conflict,
    `Reconcile ${a} against ${b}, and record which one is now correct.`,
    { kind: 'JUDGEMENT', question: `Does "${a}" contradict "${b}"? Quote both sides or answer PASS.` },
  );

// ---------------------------------------------------------------------------
// 2 · Missing Information — facts, judged from the project input. Never checks a file's existence.
// ---------------------------------------------------------------------------

const MISSING_INFORMATION: AssessmentRule[] = [
  mi('MI-001', 'Project type and lifecycle identified', 'BLOCKER', 'Project type has not been identified', 'Record the project type and its delivery lifecycle.', 'Do the project inputs identify the project type and its delivery lifecycle (waterfall phases, iterative releases, continuous operation)?'),
  mi('MI-002', 'Contract type identified', 'BLOCKER', 'Contract type is missing', 'Record the contract model, or mark the contract as pending.', 'Do the project inputs state the contract type — fixed price, time & materials, managed service, internal initiative or similar?'),
  mi('MI-003', 'Contract availability known', 'BLOCKER', 'Contract availability is unknown', 'State whether the contract is available, pending or unavailable.', 'Do the project inputs state whether a signed contract, SOW or work order is available, pending, or unavailable?'),
  mi('MI-004', 'Project scope defined', 'BLOCKER', 'Project scope has not been defined', 'Describe what this project will and will not deliver.', 'Do the project inputs define the project scope — what will be delivered, and what is out of scope?'),
  mi('MI-005', 'Planned start date known', 'HIGH', 'Planned start date is missing', 'Record the planned start date.', 'Do the project inputs state the planned start date?'),
  mi('MI-006', 'Planned end date or duration known', 'HIGH', 'Project timeline is incomplete', 'Record the planned end date or the project duration.', 'Do the project inputs state the planned end date or the project duration?'),
  mi('MI-007', 'Deliverables and milestones identified', 'BLOCKER', 'Deliverables and milestones are missing', 'List the main deliverables and their milestones.', 'Do the project inputs name the main deliverables and their milestones?'),
  mi('MI-008', 'Acceptance criteria defined', 'BLOCKER', 'Acceptance criteria are missing', 'Define how the customer will accept each deliverable.', 'Do the project inputs define acceptance criteria — how the customer will accept each deliverable?'),
  mi('MI-009', 'Project objectives recorded', 'HIGH', 'Project objectives are missing', 'Record the customer objective this project serves.', 'Do the project inputs state the customer or project objectives this project serves?'),
  mi('MI-010', 'Assumptions captured', 'MEDIUM', 'Project assumptions have not been captured', 'Write down what the plan assumes to be true.', 'Do the project inputs state any planning assumptions?'),
  mi('MI-011', 'Constraints captured', 'MEDIUM', 'Project constraints have not been captured', 'Write down the constraints the plan must respect.', 'Do the project inputs state any project constraints (budget, technology, regulatory, calendar)?'),
  mi('MI-012', 'Customer responsibilities declared', 'HIGH', 'Customer responsibilities are missing', 'List what the customer must supply and by when.', 'Do the project inputs state what the customer is responsible for supplying or deciding?'),
  mi('MI-013', 'Dependencies declared', 'HIGH', 'Project dependencies are missing', 'List the dependencies this project relies on.', 'Do the project inputs list the external or internal dependencies this project relies on?'),
  mi('MI-014', 'Critical dependency has an owner', 'HIGH', 'Critical dependency has no owner', 'Name an owner for each critical dependency.', 'Does every dependency described as critical have a named owner?'),
  mi('MI-015', 'Critical dependency has a required date', 'HIGH', 'Critical dependency has no due date', 'Give each critical dependency the date it is needed by.', 'Does every critical dependency have a date by which it is required?'),
  mi('MI-016', 'Customer decision maker identified', 'HIGH', 'Customer decision maker is not identified', 'Name the customer contact who can make decisions.', 'Do the project inputs name a customer contact or decision maker?'),
  mi('MI-017', 'Project Manager assigned', 'BLOCKER', 'Project Manager is not assigned', 'Assign a project manager to this project.', 'Is a project manager named for this project, in the inputs or as the workspace owner?'),
  mi('MI-018', 'Project organization defined', 'HIGH', 'Project organization is incomplete', 'Record the team structure or project organization.', 'Do the project inputs describe the team structure or project organization?'),
  mi('MI-019', 'Team roles and responsibilities recorded', 'HIGH', 'Team role information is incomplete', 'Give every team member a role and a responsibility.', 'Does every named team member have a role and a stated responsibility?'),
  mi('MI-020', 'Resource allocation recorded', 'HIGH', 'Resource allocation is incomplete', 'Record each member’s allocation and their start and end dates.', 'Does every team member have an allocation and start/end dates?'),
  mi('MI-021', 'Required skills defined', 'MEDIUM', 'Required project skills are not defined', 'List the skills and experience this project needs.', 'Do the project inputs state the skills or experience the project requires?'),
  mi('MI-022', 'Internal effort estimate exists', 'BLOCKER', 'Internal effort estimate is missing', 'Produce an internal effort estimate.', 'Do the project inputs contain an internal effort estimate (person-days, person-months or FTE)?'),
  mi('MI-023', 'Estimation method and source recorded', 'HIGH', 'Estimation method or data source is missing', 'State how the estimate was produced and from what data.', 'Does the estimate state the method used and the data it was based on?'),
  mi('MI-024', 'Size unit declared', 'MEDIUM', 'Project size unit is missing', 'State the size unit used (function points, story points, person-days).', 'Do the project inputs state the unit used to size the project?'),
  mi('MI-025', 'Requirement management defined', 'HIGH', 'Requirement management information is incomplete', 'Name the requirement owner, where requirements live and how they are updated.', 'Do the project inputs name a requirement owner, a repository, and how requirements are updated?'),
  mi('MI-026', 'Change request governance defined', 'HIGH', 'Change request governance is incomplete', 'Define the change log, its reviewer and its approver.', 'Do the project inputs define a change request log with a reviewer and an approver?'),
  mi('MI-027', 'Working environment described', 'HIGH', 'Working environment information is incomplete', 'Describe the development and test environments.', 'Do the project inputs describe the development and test environments?'),
  mi('MI-028', 'Security requirements described', 'BLOCKER', 'Security requirements are not defined', 'Describe the specific security requirements that apply.', 'Do the project inputs describe the specific security requirements that apply?', 'The project has specific security requirements'),
  mi('MI-029', 'Translation information complete', 'HIGH', 'Translation information is incomplete', 'Record the languages, the impact, the tooling and the person in charge.', 'Are the translation languages, impact, tooling and person in charge all stated?', 'Translation is in scope'),
  mi('MI-030', 'Supplier information complete', 'HIGH', 'Supplier information is incomplete', 'Record the supplier’s scope and responsibilities.', 'Are the supplier’s scope and responsibilities stated?', 'A subcontractor or supplier is involved'),
  mi('MI-031', 'Onsite information complete', 'MEDIUM', 'Onsite information is incomplete', 'Record the onsite location, duration and logistics.', 'Are the onsite location, duration and logistics stated?', 'Onsite work is planned'),
  mi('MI-032', 'Software licence information complete', 'HIGH', 'Software license information is incomplete', 'Record the licence owner, the budget and the approval status.', 'Are the licence owner, budget and approval status stated?', 'Commercial software is used'),
  mi('MI-033', 'Infrastructure preparation recorded', 'HIGH', 'Infrastructure preparation information is incomplete', 'Name an owner and a readiness date for each critical infrastructure item.', 'Does each critical infrastructure item have an owner and a readiness date?', 'Critical infrastructure is required'),
  mi('MI-034', 'Communication mechanism defined', 'MEDIUM', 'Communication mechanism is incomplete', 'Define the reporting, meeting and escalation channels.', 'Do the project inputs define the reporting, meeting and escalation channels?'),
  mi('MI-035', 'Objectives and measurement targets defined', 'HIGH', 'Project objectives and measurement targets are incomplete', 'Set the quality, cost and delivery targets this project is measured on.', 'Do the project inputs set quality, cost and delivery (QCD / QPPO) targets the project is measured on?'),
];

/**
 * What each Missing Information rule is *about*, as a short noun phrase — "Contract type", not
 * "Contract type is missing". Used where the fact has to be named inside a document: when a
 * generated draft leaves out a blank the assessment said the document needs, the server adds it as
 * "<subject>: {{gap:N}}", which still reads correctly once the PM's answer replaces the token.
 */
export const MISSING_INFORMATION_SUBJECT: Record<string, string> = {
  'MI-001': 'Project type and delivery lifecycle',
  'MI-002': 'Contract type',
  'MI-003': 'Contract availability',
  'MI-004': 'Project scope',
  'MI-005': 'Planned start date',
  'MI-006': 'Planned end date or duration',
  'MI-007': 'Main deliverables and milestones',
  'MI-008': 'Acceptance criteria',
  'MI-009': 'Project objectives',
  'MI-010': 'Planning assumptions',
  'MI-011': 'Project constraints',
  'MI-012': 'Customer responsibilities',
  'MI-013': 'Project dependencies',
  'MI-014': 'Owner of each critical dependency',
  'MI-015': 'Required date of each critical dependency',
  'MI-016': 'Customer decision maker',
  'MI-017': 'Project Manager',
  'MI-018': 'Project organization',
  'MI-019': 'Team roles and responsibilities',
  'MI-020': 'Resource allocation and dates',
  'MI-021': 'Required skills and experience',
  'MI-022': 'Internal effort estimate',
  'MI-023': 'Estimation method and data source',
  'MI-024': 'Project size unit',
  'MI-025': 'Requirement owner, repository and update process',
  'MI-026': 'Change request log, reviewer and approver',
  'MI-027': 'Development and test environments',
  'MI-028': 'Security requirements',
  'MI-029': 'Translation languages, impact, tooling and PIC',
  'MI-030': 'Supplier scope and responsibilities',
  'MI-031': 'Onsite location, duration and logistics',
  'MI-032': 'Software licence owner, budget and approval',
  'MI-033': 'Infrastructure owners and readiness dates',
  'MI-034': 'Reporting, meeting and escalation channels',
  'MI-035': 'Quality, cost and delivery targets',
};

// ---------------------------------------------------------------------------
// 3 · Missing Documents — expected documents. Capability, never a filename.
// ---------------------------------------------------------------------------

/**
 * Artifact lists put catalog document names first, most specific first, because the first one the
 * project type's catalog actually holds is the document Planning Documents offers to generate. An
 * SI project closes MD-009 with a Resource Management Plan, an SM one with a Skills & Capacity Plan.
 * Names that are not catalog documents (a contract, a security review record) describe evidence the
 * PM has to supply — nothing in this app generates a customer's contract.
 */
const MISSING_DOCUMENT: AssessmentRule[] = [
  md('MD-001', 'Contract, SOW or work order', 'BLOCKER', 'No contract, SOW or work order is on file', 'Upload the contract, SOW or work order, or the approved substitute.', ['Contract', 'SOW', 'Statement of Work', 'Work Order', 'Purchase Order']),
  md('MD-002', 'Contract pending record', 'BLOCKER', 'The contract is pending with no owner or target date', 'Record who is chasing the contract and when it is expected.', ['Contract Pending Record'], 'The contract is not yet available'),
  md('MD-003', 'Internal project estimation', 'BLOCKER', 'Internal Project Estimation is missing', 'Produce and confirm the internal estimation.', ['Cost Baseline', 'Service Cost Plan', 'Budget Guardrails', 'Cost Management Plan', 'Consumption & Capacity Forecast', 'Project Estimation', 'Internal Estimation']),
  md('MD-004', 'External estimation evidence', 'HIGH', 'External estimation evidence is missing', 'Attach the committed estimate given to the customer.', ['External Estimation', 'Committed Estimate', 'Proposal'], 'An external commitment has been made'),
  md('MD-005', 'Project Charter', 'BLOCKER', 'Project Charter is missing', 'Generate and confirm the Project Charter.', ['Project Charter']),
  md('MD-006', 'Project Plan', 'BLOCKER', 'Project Plan is missing', 'Generate and confirm the Project Plan.', ['PM Operating Model', 'Service Operating Model', 'Product Operating Model', 'Project Plan']),
  md('MD-007', 'Project schedule', 'BLOCKER', 'Project Schedule is missing', 'Generate and confirm the project schedule.', ['Project Schedule & Milestones', 'Release & Maintenance Calendar', 'Release Plan', 'Service Transition Plan', 'Schedule Management Plan', 'Master Schedule', 'Project Schedule']),
  md('MD-008', 'Risk and opportunity list', 'BLOCKER', 'Risk and Opportunity List is missing', 'Generate and confirm the risk list.', ['Risk Management Plan', 'Risk and Opportunity List', 'Risk Register']),
  md('MD-009', 'Resource or staffing plan', 'HIGH', 'Resource / Staffing Plan is missing', 'Generate the resource plan, or record the equivalent team section.', ['Resource Management Plan', 'Skills & Capacity Plan', 'Roles & Decision Rights', 'Staffing Plan']),
  md('MD-010', 'Communication plan', 'HIGH', 'Communication Plan is missing', 'Generate the communication plan, or record the equivalent Project Plan section.', ['Communications Management Plan', 'Service Reporting Plan', 'Communication Plan']),
  md('MD-011', 'Requirement management approach', 'HIGH', 'Requirement Management approach is missing', 'Record how requirements are captured, owned and traced.', ['Requirements Management Plan', 'Service Scope & Catalogue', 'Backlog Management Approach', 'Scope Management Plan']),
  md('MD-012', 'Requirement change process', 'HIGH', 'Requirement Change Process is missing', 'Record how a requirement change is raised, reviewed and approved.', ['Change Management Plan', 'Decision Log', 'Requirement Change Process']),
  md('MD-013', 'Configuration management plan', 'HIGH', 'CM Plan is missing', 'Record the configuration management approach, or the approved embedded section.', ['Configuration Management Plan', 'CM Plan'], 'The project has its own development or test environment'),
  md('MD-014', 'Infrastructure management evidence', 'HIGH', 'Project Infrastructure Management evidence is missing', 'Record how infrastructure, cloud, VPN and accounts are managed.', ['Project Infrastructure Management', 'Infrastructure Plan'], 'Infrastructure, cloud, VPN or accounts are required'),
  md('MD-015', 'Project security rules', 'BLOCKER', 'Project Security Rules are missing', 'Record the security rules that apply to this project.', ['Project Security Rules', 'Security Management Plan'], 'The project has specific security requirements'),
  md('MD-016', 'Security review evidence', 'BLOCKER', 'Security review evidence is missing', 'Attach the record of the security review.', ['Security Review Record'], 'A security action is required'),
  md('MD-017', 'Security training record', 'HIGH', 'Security training / transfer record is missing', 'Record that the security rules were transferred to the team.', ['Security Training Record'], 'A required security rule applies'),
  md('MD-018', 'Translation quality assessment', 'HIGH', 'Translation Quality Assessment is missing', 'Produce the translation quality assessment.', ['Translation Quality Assessment'], 'Translation is in scope'),
  md('MD-019', 'Translation plan', 'HIGH', 'Translation Plan is missing', 'Produce the translation plan.', ['Translation Plan'], 'Translation is in scope'),
  md('MD-020', 'Integration strategy', 'HIGH', 'Integration Strategy is missing', 'Record the integration strategy.', ['WBS & Integration Boundary', 'Integration Strategy'], 'Integration testing is in scope'),
  md('MD-021', 'Standalone product integration plan', 'HIGH', 'Standalone Product Integration Plan is missing', 'Produce a standalone integration plan for this effort size.', ['Product Integration Plan'], 'A development project above 1,000 person-days whose integration is not Big Bang'),
  md('MD-022', 'Test strategy or test plan', 'HIGH', 'Test Strategy / Test Plan is missing', 'Produce the test strategy or test plan.', ['Test Strategy', 'Test Plan', 'Quality Management Plan'], 'Testing is in scope'),
  md('MD-023', 'Review strategy', 'HIGH', 'Review Strategy is missing', 'Record which deliverables are reviewed and how.', ['Review Strategy', 'Quality Management Plan'], 'Review activities are in scope'),
  md('MD-024', 'Quality plan', 'HIGH', 'Quality Plan is missing', 'Produce the quality plan, or record the embedded quality section.', ['Quality Management Plan', 'Quality Plan'], 'Quality planning applies'),
  md('MD-025', 'Measurement program', 'HIGH', 'Measurement Program is missing', 'Record what is measured and how often.', ['Measurement Program', 'Quality Management Plan'], 'Measurement applies'),
  md('MD-026', 'Mitigation and contingency plan', 'HIGH', 'Mitigation / contingency plan is missing', 'Record a mitigation and a contingency for each significant risk.', ['Risk Management Plan', 'Contingency Plan'], 'A risk response is required'),
  md('MD-027', 'Training plan', 'MEDIUM', 'Training Plan is missing', 'Produce the training plan.', ['Handoff & Capability Plan', 'Knowledge Transfer Plan', 'Capability Plan', 'Training Plan'], 'Training is required'),
  md('MD-028', 'Tailoring and deviation list', 'HIGH', 'Tailoring / Deviation List is missing', 'List every tailoring and deviation from the standard process.', ['Tailoring List', 'Deviation List'], 'A tailoring or deviation exists'),
  md('MD-029', 'Deviation approval evidence', 'BLOCKER', 'Deviation approval evidence is missing', 'Attach the approval from the correct authority level.', ['Deviation Approval'], 'A deviation exists'),
  md('MD-030', 'Product vision or roadmap', 'HIGH', 'Product Vision / Roadmap is missing', 'Produce the product vision or roadmap.', ['Product Vision & Scope', 'Outcome Roadmap', 'Product Vision', 'Product Roadmap'], 'The project runs an agile approach'),
  md('MD-031', 'Product backlog', 'BLOCKER', 'Product Backlog is missing', 'Produce the product backlog, at least to the opening sprint.', ['Backlog Management Approach', 'Maintenance Backlog Approach', 'Product Backlog'], 'The project runs an agile approach'),
  md('MD-032', 'Way of work', 'HIGH', 'Way of Work is missing', 'Record the team’s way of working.', ['Product Team Working Agreement', 'Way of Work'], 'The project runs an agile approach'),
  md('MD-033', 'Definition of done', 'HIGH', 'Definition of Done is missing', 'Record the Definition of Done.', ['Definition of Ready / Done', 'Product Team Working Agreement', 'Definition of Done'], 'The project runs an agile approach'),
  md('MD-034', 'Opening sprint backlog', 'HIGH', 'Opening Sprint Backlog / Task List is missing', 'Produce the opening sprint backlog.', ['Iteration Cadence', 'Opening Sprint Backlog', 'Sprint Backlog'], 'The project runs an agile approach'),
  md('MD-035', 'FIT/GAP artifact', 'HIGH', 'FIT/GAP artifact is missing', 'Produce the FIT/GAP analysis.', ['FIT/GAP Analysis'], 'The project is a package implementation'),
  md('MD-036', 'Blueprint or system overview', 'HIGH', 'Blueprint / System Overview is missing', 'Produce the blueprint or system overview.', ['Blueprint', 'System Overview'], 'The project is a package implementation'),
  md('MD-037', 'Supplier plan and scope allocation', 'HIGH', 'Supplier plan / SOW and scope allocation are missing', 'Record the supplier plan and which scope is allocated to them.', ['Supplier Plan', 'Supplier SOW'], 'The project uses supplier-controlled delivery (SCDM)'),
  md('MD-038', 'Prime involvement in supplier test strategy', 'HIGH', 'Prime involvement in the supplier test strategy is not evidenced', 'Record how the prime takes part in the supplier’s test strategy.', ['Supplier Test Strategy'], 'The project uses supplier-controlled delivery (SCDM)'),
  md('MD-039', 'Open-source control plan', 'HIGH', 'OSS control / review plan is missing', 'Record how open-source and third-party components are reviewed.', ['OSS Review Plan', 'Open Source Control Plan'], 'Open-source or third-party components are used'),
  md('MD-040', 'CI/CD assessment', 'HIGH', 'CI/CD Assessment and Resolution is missing', 'Produce the CI/CD assessment.', ['CI/CD Assessment'], 'CI/CD applies to this project'),
  md('MD-041', 'AI data management areas', 'HIGH', 'AI data management areas are not defined', 'Define the AI data management areas and their controls.', ['AI Data Management Plan'], 'The project builds or uses AI'),
  md('MD-042', 'Planning review record', 'BLOCKER', 'Planning Review Record is missing', 'Record the planning review and its outcome.', ['Planning Review Record'], 'The project has reached its Planning Review'),
  md('MD-043', 'Kick-off deck and meeting record', 'MEDIUM', 'Kick-off deck and meeting record are missing', 'Produce the kickoff deck and record the meeting.', ['Kickoff Deck', 'Kick-off Meeting Record'], 'A kick-off is required or has taken place'),
  md('MD-044', 'Pre-planning meeting record', 'MEDIUM', 'Pre-planning meeting record is missing', 'Record the pre-planning meeting.', ['Pre-planning Meeting Record'], 'A pre-planning meeting is required'),
];

/**
 * The document Planning Documents offers to generate when a Missing Document rule fails and this
 * project type's standard catalog holds nothing in its `artifacts` list.
 *
 * Any document the assessment finds missing has to be something the PM can produce, not a dead end
 * reading "missing" with no way to close it — so the catalog is not the limit. The first time a
 * project needs one of these, a definition is created for its project type (`extended`), and it
 * appears in Planning Documents for that project. The domain is what files it into a work product:
 * SCHEDULE → Project Schedule, FINANCE → Project Estimation, everything else → Project Plan.
 */
export const MISSING_DOCUMENT_FALLBACK: Record<string, { name: string; domain: ManagementDomain }> = {
  'MD-001': { name: 'Statement of Work', domain: 'GOVERNANCE' },
  'MD-002': { name: 'Contract Pending Record', domain: 'GOVERNANCE' },
  'MD-003': { name: 'Project Estimation', domain: 'FINANCE' },
  'MD-004': { name: 'External Estimation', domain: 'FINANCE' },
  'MD-005': { name: 'Project Charter', domain: 'GOVERNANCE' },
  // Not "Project Plan": that name belongs to the retired house workbook (PROJECT_PLAN).
  'MD-006': { name: 'Project Management Plan', domain: 'GOVERNANCE' },
  'MD-007': { name: 'Project Schedule', domain: 'SCHEDULE' },
  'MD-008': { name: 'Risk Management Plan', domain: 'RISK' },
  'MD-009': { name: 'Resource Management Plan', domain: 'RESOURCES' },
  'MD-010': { name: 'Communications Management Plan', domain: 'STAKEHOLDERS' },
  'MD-011': { name: 'Requirements Management Plan', domain: 'SCOPE' },
  'MD-012': { name: 'Change Management Plan', domain: 'GOVERNANCE' },
  'MD-013': { name: 'Configuration Management Plan', domain: 'GOVERNANCE' },
  'MD-014': { name: 'Project Infrastructure Management Plan', domain: 'RESOURCES' },
  'MD-015': { name: 'Project Security Rules', domain: 'GOVERNANCE' },
  'MD-016': { name: 'Security Review Record', domain: 'GOVERNANCE' },
  'MD-017': { name: 'Security Training Record', domain: 'RESOURCES' },
  'MD-018': { name: 'Translation Quality Assessment', domain: 'GOVERNANCE' },
  'MD-019': { name: 'Translation Plan', domain: 'GOVERNANCE' },
  'MD-020': { name: 'Integration Strategy', domain: 'SCOPE' },
  'MD-021': { name: 'Product Integration Plan', domain: 'SCOPE' },
  'MD-022': { name: 'Test Strategy', domain: 'GOVERNANCE' },
  'MD-023': { name: 'Review Strategy', domain: 'GOVERNANCE' },
  'MD-024': { name: 'Quality Management Plan', domain: 'GOVERNANCE' },
  'MD-025': { name: 'Measurement Program', domain: 'GOVERNANCE' },
  'MD-026': { name: 'Risk Management Plan', domain: 'RISK' },
  'MD-027': { name: 'Training Plan', domain: 'RESOURCES' },
  'MD-028': { name: 'Tailoring & Deviation List', domain: 'GOVERNANCE' },
  'MD-029': { name: 'Deviation Approval Record', domain: 'GOVERNANCE' },
  'MD-030': { name: 'Product Vision & Roadmap', domain: 'SCOPE' },
  'MD-031': { name: 'Product Backlog', domain: 'SCOPE' },
  'MD-032': { name: 'Way of Work', domain: 'GOVERNANCE' },
  'MD-033': { name: 'Definition of Done', domain: 'SCOPE' },
  'MD-034': { name: 'Opening Sprint Backlog', domain: 'SCHEDULE' },
  'MD-035': { name: 'FIT/GAP Analysis', domain: 'SCOPE' },
  'MD-036': { name: 'Solution Blueprint', domain: 'SCOPE' },
  'MD-037': { name: 'Supplier Management Plan', domain: 'RESOURCES' },
  'MD-038': { name: 'Supplier Test Strategy', domain: 'GOVERNANCE' },
  'MD-039': { name: 'Open Source Control Plan', domain: 'GOVERNANCE' },
  'MD-040': { name: 'CI/CD Assessment', domain: 'GOVERNANCE' },
  'MD-041': { name: 'AI Data Management Plan', domain: 'GOVERNANCE' },
  'MD-042': { name: 'Planning Review Record', domain: 'GOVERNANCE' },
  'MD-043': { name: 'Kickoff Deck', domain: 'KICKOFF' },
  'MD-044': { name: 'Pre-planning Meeting Record', domain: 'GOVERNANCE' },
};

// ---------------------------------------------------------------------------
// 4 · Planning risks — derived from evidence, gaps and mismatches. Not the register.
// ---------------------------------------------------------------------------

const PLANNING_RISK: AssessmentRule[] = [
  rk('RK-001', 'Contract exposure', 'BLOCKER', 'Contract exposure: work is planned or under way with no contract', 'Escalate to secure the contract, or pause the committed start.', 'Is the contract unavailable while the project has started or is planned to start?'),
  rk('RK-002', 'Uncontrolled contract dependency', 'HIGH', 'Uncontrolled contract dependency: the pending contract has no owner or date', 'Name an owner and a target date for the contract.', 'Is the contract pending without a named owner and a target date?'),
  rk('RK-003', 'Scope growth and margin risk', 'HIGH', 'Scope growth and margin risk on a fixed-price contract', 'Fix the requirement baseline, or move the unstable scope behind change control.', 'Is the contract fixed price while the requirements are described as unstable or still changing?'),
  rk('RK-004', 'Payment dependency risk', 'HIGH', 'Payment dependency risk: fixed price, customer environment, unclear payment conditions', 'Confirm the payment milestones and what triggers them.', 'Is this fixed price, delivered on the customer’s environment, with payment conditions left unclear?'),
  rk('RK-005', 'Estimation reliability risk', 'HIGH', 'Estimation reliability risk: an estimate was committed on unclear scope', 'Re-estimate once scope is settled, or record the commitment as provisional.', 'Was an estimate committed while the scope was still not clearly defined?'),
  rk('RK-006', 'Estimate uncertainty risk', 'HIGH', 'Estimate uncertainty risk: the estimate records no assumptions or constraints', 'Record the assumptions and constraints the estimate rests on.', 'Does the estimate lack stated assumptions or constraints?'),
  rk('RK-007', 'Commercial delivery risk', 'HIGH', 'Commercial delivery risk: internal and external estimates differ with no rationale', 'Explain the difference, or align the two estimates.', 'Do the internal and external estimates differ without a stated rationale?'),
  rk('RK-008', 'Planning feasibility risk', 'MEDIUM', 'Planning feasibility risk: effort distribution departs from the historical baseline', 'Explain the distribution, or re-plan the phases.', 'Does the effort distribution across phases depart from historical or PCB norms without a rationale?'),
  rk('RK-009', 'Resource feasibility risk', 'HIGH', 'Resource feasibility risk: calendar effort and effort usage differ by more than 10%', 'Reconcile the calendar against the effort model.', 'Do calendar effort and effort usage differ by more than 10% without a rationale?'),
  rk('RK-010', 'Schedule control risk', 'HIGH', 'Schedule control risk: no critical path or baseline', 'Baseline the schedule and mark its critical path.', 'Does the schedule lack a critical path or a baseline?'),
  rk('RK-011', 'Incomplete schedule risk', 'HIGH', 'Incomplete schedule risk: training, CM, QA or risk actions are not scheduled', 'Add the missing activities to the schedule.', 'Does the schedule omit training, configuration management, QA or risk actions?'),
  rk('RK-012', 'Governance schedule risk', 'HIGH', 'Governance schedule risk: a milestone gap exceeds policy with no approved exception', 'Add an intermediate milestone, or obtain an approved exception.', 'Is any milestone gap longer than policy allows without an approved exception?'),
  rk('RK-013', 'External dependency risk', 'HIGH', 'External dependency risk: a critical dependency is unconfirmed', 'Confirm the dependency with its owner.', 'Is any critical dependency still unconfirmed?'),
  rk('RK-014', 'Start-up delay risk', 'HIGH', 'Start-up risk: customer input, accounts or environment arrive after they are needed', 'Bring the delivery date forward, or re-sequence the work that waits on it.', 'Does any customer input, account or environment arrive after the date the plan needs it?'),
  rk('RK-015', 'Key-person staffing risk', 'HIGH', 'Key-person staffing risk: a key role is unstaffed before its activities start', 'Staff the role, or move its activities.', 'Is any key role still unstaffed before the activities that need it begin?'),
  rk('RK-016', 'Capability gap risk', 'HIGH', 'Capability gap risk: a required skill is not covered by the team', 'Recruit, train or subcontract the missing skill.', 'Is any required skill not covered by a named team member?'),
  rk('RK-017', 'Readiness risk', 'MEDIUM', 'Readiness risk: training is required with no trainer, material or schedule', 'Assign a trainer, prepare the material and schedule it.', 'Is training required without a trainer, material or a scheduled date?'),
  rk('RK-018', 'Coordination risk', 'MEDIUM', 'Coordination risk: multi-site or onsite work with no clear communication mechanism', 'Define how the sites coordinate and how often.', 'Is the work multi-site or onsite without a clear communication mechanism?'),
  rk('RK-019', 'Scope-control risk', 'HIGH', 'Scope-control risk: high requirement volatility with no change process', 'Put a change request process in place before work starts.', 'Are requirements highly volatile with no change request process defined?'),
  rk('RK-020', 'Requirement governance risk', 'HIGH', 'Requirement governance risk: no clear requirement or change owner', 'Name the owner of requirements and of changes to them.', 'Is the owner of requirements or of requirement changes left unclear?'),
  rk('RK-021', 'Risk assessment quality issue', 'MEDIUM', 'Risk assessment quality issue: risks carry no probability, impact or priority', 'Score every risk for probability, impact and priority.', 'Do any risks lack a probability, an impact or a priority?'),
  rk('RK-022', 'Uncontrolled critical risk', 'BLOCKER', 'Uncontrolled critical risk: a high or critical risk has no mitigation and no contingency', 'Add a mitigation and a contingency for each critical risk.', 'Does any high or critical risk lack both a mitigation and a contingency?'),
  rk('RK-023', 'Unowned risk response', 'HIGH', 'Unowned risk response: a risk action has no owner or due date', 'Give every risk action an owner and a due date.', 'Does any risk action lack a person in charge or a due date?'),
  rk('RK-024', 'Security compliance risk', 'BLOCKER', 'Security compliance risk: security requirements exist with no review or action', 'Run the security review and record its actions.', 'Do security requirements exist with no review or resulting action recorded?'),
  rk('RK-025', 'Security adoption risk', 'HIGH', 'Security adoption risk: the security rules have not reached the team', 'Transfer and train the security rules to everyone delivering.', 'Have the security rules not been transferred to or trained with the team?'),
  rk('RK-026', 'Infrastructure control risk', 'HIGH', 'Infrastructure control risk: connection, cloud or account owner is not qualified', 'Assign a qualified owner and record the control.', 'Is a specific connection, cloud service or account used whose controller or owner is not qualified?'),
  rk('RK-027', 'Licence compliance risk', 'HIGH', 'Licence risk: a required licence is not approved', 'Obtain licence approval before the work that needs it.', 'Is a licence required but not yet approved?'),
  rk('RK-028', 'Open-source compliance risk', 'HIGH', 'Open-source compliance risk: OSS is used with no scan or review plan', 'Put an OSS scan and review plan in place.', 'Is open-source software used without a scan or review plan?'),
  rk('RK-029', 'Delivery automation risk', 'MEDIUM', 'Delivery automation risk: a CI/CD-eligible project has had no assessment', 'Run the CI/CD assessment.', 'Is this a development project eligible for CI/CD with no assessment done?'),
  rk('RK-030', 'Asset control risk', 'MEDIUM', 'Asset control risk: customer-supplied assets have no control or storage method', 'Record how customer assets are stored and controlled.', 'Are customer-supplied assets used with no stated control or storage method?'),
  rk('RK-031', 'Process compliance risk', 'BLOCKER', 'Process compliance risk: a tailoring or deviation has no approval', 'Obtain approval at the authority level the matrix requires.', 'Does any tailoring or deviation lack an approval?'),
  rk('RK-032', 'Objective feasibility risk', 'HIGH', 'Objective feasibility risk: the QCD targets do not align with the commitment', 'Align the targets with what was committed, or renegotiate.', 'Do the quality, cost and delivery targets conflict with the customer commitment or the organisational norm?'),
  rk('RK-033', 'Quality escape risk', 'HIGH', 'Quality escape risk: the review or test strategy does not cover every deliverable', 'Extend the strategy to cover every deliverable.', 'Does the review or test strategy leave any deliverable uncovered?'),
  rk('RK-034', 'Translation quality risk', 'HIGH', 'Translation quality risk: translation is in scope with no impact assessment', 'Assess the translation impact before committing the schedule.', 'Is translation applicable with no impact assessment done?'),
  rk('RK-035', 'Supplier delivery risk', 'HIGH', 'Supplier delivery risk: supplier output or test responsibility is unclear', 'Write down what the supplier delivers and who tests it.', 'Under supplier-controlled delivery, is the supplier’s output or test responsibility unclear?'),
  rk('RK-036', 'AI data governance risk', 'HIGH', 'AI data governance risk: AI data areas and controls are not defined', 'Define the AI data areas and their controls.', 'For an AI project, are the data management areas and controls undefined?'),
  rk('RK-037', 'Agile coordination risk', 'MEDIUM', 'Agile coordination risk: a team larger than nine with no splitting decision', 'Split the team, or record why one team is right.', 'Is the agile team larger than nine people with no team-splitting decision recorded?'),
  rk('RK-038', 'Planning readiness risk', 'BLOCKER', 'Planning readiness risk: mandatory checks are still failing', 'Close every blocker before declaring planning complete.', 'Are any mandatory Planning Review checks still failing?'),
];

// ---------------------------------------------------------------------------
// 5 · Conflicts — two sources that disagree. Absence is never a conflict.
// ---------------------------------------------------------------------------

const CONFLICT: AssessmentRule[] = [
  cf('CF-001', 'Scope mismatch', 'the contract scope', 'the Project Plan scope', 'Scope mismatch between the contract and the Project Plan'),
  cf('CF-002', 'Deliverable mismatch', 'the contract deliverables', 'the Project Schedule deliverables', 'Deliverable mismatch between the contract and the schedule'),
  cf('CF-003', 'Milestone mismatch', 'the contract milestones', 'the Project Schedule milestones', 'Milestone mismatch between the contract and the schedule'),
  cf('CF-004', 'Acceptance criteria mismatch', 'the contract acceptance criteria', 'the Project Plan acceptance criteria', 'Acceptance criteria differ between the contract and the Project Plan'),
  cf('CF-005', 'Effort commitment mismatch', 'the external estimation', 'the internal estimation', 'Committed effort differs from the internal estimate'),
  cf('CF-006', 'Estimation coverage mismatch', 'the estimation scope', 'the requirement and contract scope', 'The estimate does not cover the contracted scope'),
  cf('CF-007', 'Capacity mismatch', 'the estimated effort', 'the resource allocation', 'Allocated resource does not match the estimated effort'),
  cf('CF-008', 'Effort model mismatch', 'the calendar effort', 'the effort usage', 'Calendar effort and effort usage describe different models'),
  cf('CF-009', 'Skill coverage mismatch', 'the required skills', 'the assigned members’ skills', 'Assigned members do not cover the required skills'),
  cf('CF-010', 'Resource timing mismatch', 'the resource start and end dates', 'the scheduled activity dates', 'Resources are not available when their activities are scheduled'),
  cf('CF-011', 'Commercial approach mismatch', 'the fixed-price contract type', 'a scope marked continuously changeable with no change control', 'A fixed-price contract is paired with uncontrolled changeable scope'),
  cf('CF-012', 'Declared methodology mismatch', 'the declared agile approach', 'the absence of a backlog, product owner, iteration or review mechanism', 'Agile is declared but its mechanisms are absent'),
  cf('CF-013', 'Methodology-context mismatch', 'the declared waterfall approach', 'volatile requirements with short backlog-driven iterations', 'Waterfall is declared but the project behaves iteratively'),
  cf('CF-014', 'Governance-method mismatch', 'the declared agile approach', 'a contract requiring phase-gate, document-heavy approval', 'Agile delivery conflicts with the contract’s approval model'),
  cf('CF-015', 'Responsibility mismatch', 'the customer responsibilities', 'the dependency owners', 'Responsibility for the same item is assigned twice'),
  cf('CF-016', 'Dependency-date mismatch', 'the date a dependency is required', 'the date it is committed for', 'A dependency is committed later than it is needed'),
  cf('CF-017', 'Technical environment mismatch', 'the Project Plan technology', 'the CM or infrastructure technology', 'The plan and the environment describe different technology'),
  cf('CF-018', 'Security coverage mismatch', 'the security requirements', 'the CM plan and security controls', 'The controls do not cover the stated security requirements'),
  cf('CF-019', 'Requirement-schedule mismatch', 'the requirement list', 'the scheduled scope', 'The schedule does not cover every requirement'),
  cf('CF-020', 'Change governance mismatch', 'the requirement change process', 'the contract change conditions', 'The internal change process contradicts the contract'),
  cf('CF-021', 'Lifecycle-quality mismatch', 'the project lifecycle', 'the selected review and test activities', 'The quality activities do not suit the chosen lifecycle'),
  cf('CF-022', 'Tailoring implementation mismatch', 'the declared tailoring', 'the artifacts and processes actually selected', 'What was tailored is not what is being done'),
  cf('CF-023', 'Objective mismatch', 'the quality, cost and delivery targets', 'the contract or customer commitment', 'Internal targets contradict what was committed'),
  cf('CF-024', 'Risk action scheduling mismatch', 'the risk mitigation actions', 'the Project Schedule', 'Risk actions are not in the schedule'),
  cf('CF-025', 'Assessment profile mismatch', 'the project rank and type', 'the checklist or profile applied', 'The wrong assessment profile is being applied'),
  cf('CF-026', 'Planning baseline mismatch', 'the Project Plan, Charter and Schedule versions', 'each other', 'The planning documents are on different baselines'),
  cf('CF-027', 'SCDM scope mismatch', 'the supplier scope', 'the prime project plan', 'Supplier scope and prime plan do not agree'),
  cf('CF-028', 'Translation coverage mismatch', 'the translation scope', 'the translation schedule and plan', 'The translation plan does not cover the translation scope'),
  cf('CF-029', 'Integration approach mismatch', 'the product integration strategy', 'the development architecture and modularity', 'The integration strategy does not suit the architecture'),
  cf('CF-030', 'Asset inventory mismatch', 'the customer-supplied asset list', 'the CM or infrastructure asset list', 'The two asset inventories do not agree'),
];

export const ASSESSMENT_RULES: AssessmentRule[] = [
  ...MISSING_INFORMATION,
  ...MISSING_DOCUMENT,
  ...PLANNING_RISK,
  ...CONFLICT,
];

export const RULES_BY_CATEGORY: Record<AssessmentCategory, AssessmentRule[]> = {
  MISSING_INFORMATION,
  MISSING_DOCUMENT,
  PLANNING_RISK,
  CONFLICT,
};

export const RULE_BY_ID = new Map(ASSESSMENT_RULES.map((rule) => [rule.ruleId, rule]));

/**
 * The tab order on the Planning Assessment screen. Overview and Methodology Fit are not rule
 * categories — the first summarises, the last is a recommendation score rather than a governance
 * check — so they are named here rather than derived.
 */
export const ASSESSMENT_TABS = [
  { key: 'overview', label: 'Overview', category: null },
  { key: 'information', label: 'Missing Information', category: 'MISSING_INFORMATION' as const },
  { key: 'documents', label: 'Missing Documents', category: 'MISSING_DOCUMENT' as const },
  { key: 'risks', label: 'Risks', category: 'PLANNING_RISK' as const },
  { key: 'conflicts', label: 'Conflicts', category: 'CONFLICT' as const },
  { key: 'fit', label: 'Methodology Fit', category: null },
];

/**
 * What a PM action records when it is closed because the PM ticked its rule as met. Shared so that
 * unticking can find — and reopen — exactly the actions that were closed on the strength of the tick.
 */
export const TICK_CLOSE_REASON = 'Ticked as met by the PM in Standards';

/** The two categories whose failures become PM actions — both are "something is missing". */
export const ACTIONABLE_CATEGORIES: AssessmentCategory[] = ['MISSING_INFORMATION', 'MISSING_DOCUMENT'];
