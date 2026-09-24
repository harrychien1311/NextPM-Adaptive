export type ProjectType = 'SI' | 'SM' | 'PRODUCT';
export type ProjectStatus = 'DRAFT' | 'ACTIVE' | 'HOLD' | 'CLOSED';
/**
 * A governance model code. The AI scores WATERFALL / SCRUM / KANBAN / HYBRID / ITERATIVE /
 * STAGE_GATE by default, but may propose another when the evidence calls for it — so this
 * stays a plain string rather than a fixed union.
 */
export type Approach = string;
export const DEFAULT_GOVERNANCE_MODELS = ['WATERFALL', 'SCRUM', 'KANBAN', 'HYBRID', 'ITERATIVE', 'STAGE_GATE'] as const;
export type ManagementDomain =
  | 'GOVERNANCE'
  | 'SCOPE'
  | 'SCHEDULE'
  | 'FINANCE'
  | 'STAKEHOLDERS'
  | 'RESOURCES'
  | 'RISK'
  | 'PROJECT_PLAN'
  | 'KICKOFF';
export type DocumentStatus = 'NOT_GENERATED' | 'GENERATING' | 'PM_REVIEW' | 'APPROVED' | 'SUPERSEDED';

/** Global account role. ADMIN manages accounts only and never sees a project workspace. */
export type Role = 'ADMIN' | 'PROGRAM_OWNER' | 'PROJECT_OWNER';
/** A user's role inside one project — independent of their account role. */
export type ProjectRole = 'OWNER' | 'MEMBER' | 'VIEWER';

export interface User {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: Role;
  jobTitle: string;
}

export interface AdminAccount {
  id: string;
  email: string;
  name: string;
  initials: string;
  jobTitle: string;
  role: Role;
  active: boolean;
  createdAt: string;
  ownedProjects: number;
  ownedPrograms: number;
  memberships: number;
}

export interface AdminAccountList {
  users: AdminAccount[];
  counts: { total: number; active: number; admins: number; programOwners: number; projectOwners: number };
}

export interface ProgramSummary {
  programs: number;
  activePrograms: number;
  activeProjects: number;
  /** Projects this user may actually open — the rest are visible but locked. */
  myProjects: number;
  byType: Record<'SI' | 'SM' | 'PRODUCT', number>;
  needsAttention: number;
  pendingDecisions: number;
  deliveryReadiness: number;
  statusCounts: Record<'all' | 'active' | 'draft' | 'hold' | 'closed', number>;
}

export interface ProjectCard {
  id: string;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  summary: string | null;
  customer: string | null;
  programId: string | null;
  targetLabel: string | null;
  programKey: string;
  programName: string;
  approach: Approach | null;
  openDecisions: number;
  members: { id: string; initials: string; name: string }[];
  /** False when the viewer may see the card but has not been granted the workspace. */
  canOpen: boolean;
  /** May rename, re-file or change the status of this project. */
  canEdit: boolean;
  /** May delete it — stricter than canEdit, since deletion cascades and cannot be undone. */
  canDelete: boolean;
  /**
   * May record a plan change from here: there is a confirmed governance model to change, and the
   * viewer can write. Before a plan exists the right action is the analysis itself.
   */
  canChangePlan: boolean;
  readiness: number;
  /** See `Workspace.basis` — the same number, built the same way, on the overview card. */
  basis: 'CUSTOMER_AND_OUTPUTS' | 'CUSTOMER' | 'INPUT_AND_OUTPUTS' | 'INPUT';
  outputShare: number;
  inputReadiness: number;
  verifiedInputs: number;
  totalInputs: number;
  documentsTotal: number;
  documentsGenerated: number;
  documentsApproved: number;
  documentsInReview: number;
}

export interface ProgramGroup {
  key: string;
  id: string | null;
  name: string;
  description: string | null;
  targetOutcome: string | null;
  colorKey: string;
  readiness: number | null;
  health: 'good' | 'watch' | 'risk' | 'none';
  projects: ProjectCard[];
}

export interface ProgramOverview {
  capabilities: { canCreateProgram: boolean; canCreateProject: boolean; canOpenAll: boolean };
  summary: ProgramSummary;
  groups: ProgramGroup[];
}

export interface Workspace {
  id: string;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  /** What the customer reference library matches on — free text, set only by the PM. */
  customer: string | null;
  /**
   * The governance model the PM declared on Project Input before any analysis ran. `null` means
   * "not decided yet", and that null is what asks the analysis to recommend one instead of scoring
   * a choice already made. Distinct from `approach`, which is the confirmed decision.
   */
  preferredApproach: string | null;
  phaseLabel: string;
  program: { id: string; name: string; key: string } | null;
  members: { id: string; name: string; initials: string }[];
  approach: { approach: Approach; rigor: string; outcome: string; decidedAt: string } | null;
  recommendation: { approach: Approach; confidence: number } | null;
  /**
   * The viewer's role **on this project**. `OWNER` may write; `MEMBER` and `VIEWER` are read-only,
   * and the workspace disables its controls for them rather than offering buttons the server will
   * refuse. Never a substitute for the server's own check — see `requireProjectRole`.
   */
  projectRole: 'OWNER' | 'MEMBER' | 'VIEWER' | null;
  readiness: number;
  /**
   * What `readiness` was built from. Once the customer's own standard has been assessed it is that
   * standard plus the approved planning outputs; a project whose customer has no checklist in the
   * library falls back to verified inputs plus approved outputs. The dashboard names whichever
   * applies rather than showing a bare percentage.
   */
  basis: 'CUSTOMER_AND_OUTPUTS' | 'CUSTOMER' | 'INPUT_AND_OUTPUTS' | 'INPUT';
  /** Share of this project's planning documents that the PM has approved. */
  outputShare: number;
  inputReadiness: number;
  verifiedInputs: number;
  totalInputs: number;
  documentsTotal: number;
  documentsGenerated: number;
  documentsApproved: number;
  documentsInReview: number;
}

export interface ProjectTeamMember {
  id: string;
  userId: string;
  role: ProjectRole;
  createdAt: string;
  user: { id: string; name: string; initials: string; jobTitle: string };
}

export interface ActionItem {
  id: string;
  /**
   * `GAP` is a stored `ActionItem` the analysis opened. `STALE_DOCUMENT` is derived on read from a
   * document an applied plan change made out of date — it has no row, so it cannot be resolved or
   * closed; it disappears when the document is regenerated or deleted.
   */
  kind: 'GAP' | 'STALE_DOCUMENT';
  priority: 'REQUIRED' | 'CONDITIONAL' | 'INFO';
  domain: ManagementDomain;
  title: string;
  description: string | null;
  targetView: 'input' | 'approach' | 'studio';
  /** The catalog document this action is about, so "Open" can land on it rather than on the Studio's own default. */
  targetDocument: string | null;
  /**
   * Where that document has got to in the Studio. `APPROVED` means the PM has pressed *PM confirm*
   * on it, which is what marks this action ready to close — the server reports it, the PM closes it.
   */
  targetDocumentStatus: DocumentStatus | null;
  suggestions: string[];
  blocksDocument: string | null;
}

/** One row of the dashboard's Planning documents list — an upload or an AI draft. */
export interface LibraryEntry {
  id: string;
  kind: 'UPLOAD' | 'GENERATED';
  origin: 'PM_INPUT' | 'AI_GENERATED';
  name: string;
  category: string;
  status: string;
  sizeBytes: number | null;
  at: string | null;
}

/** An uploaded file with the text extracted from it on upload. */
export interface ReferenceDetail {
  id: string;
  fileName: string;
  group: string;
  /** Decides whether the preview can embed the original or has to offer it as a download. */
  mimeType: string;
  status: string;
  message: string | null;
  sizeBytes: number;
  uploadedAt: string;
  textAvailable: boolean;
  text: string | null;
}

export interface DashboardResponse {
  workspace: Workspace;
  startReadiness: {
    score: number;
    verdict: { label: string; tone: string };
    blockers: number;
    note: string;
  };
  outputs: {
    total: number;
    generated: number;
    approved: number;
    inReview: number;
    notGenerated: number;
    percent: number;
  };
  tasks: {
    items: { id: string; title: string; detail: string | null; state: 'TODO' | 'REVIEW' | 'BLOCKED' | 'DONE' }[];
    complete: number;
    total: number;
  };
  actions: ActionItem[];
  domains: { domain: ManagementDomain; score: number; target: number }[];
  /** The three most recent plan changes, for the dashboard panel. The full story is its own screen. */
  planChanges: {
    id: string;
    status: PlanChangeStatus;
    summary: string;
    at: string;
    by: string;
    documents: number;
    affected: number;
  }[];
  library: LibraryEntry[];
  activity: {
    id: string;
    type: string;
    title: string;
    detail: string | null;
    actorType: string;
    createdAt: string;
    actor: { name: string; initials: string } | null;
  }[];
  widgets: Record<string, boolean>;
}

export interface InputField {
  definitionId: string;
  key: string;
  label: string;
  fieldType: 'TEXT' | 'TEXTAREA' | 'DATE' | 'DATE_RANGE' | 'SELECT' | 'NUMBER';
  options: string[];
  required: boolean;
  domain: ManagementDomain;
  value: string | null;
  source: string;
  verified: boolean;
  conflictNote: string | null;
}

export interface InputProfile {
  projectType: ProjectType;
  /** What the customer library matches on. Free text, set only by the PM. */
  customer: string | null;
  customerSuggestion: CustomerSuggestion | null;
  fields: InputField[];
  readiness: number;
  counters: { total: number; pmInput: number; fileReference: number; missing: number; verified: number };
  customFields: { id: string; name: string; value: string | null; useIn: string }[];
  referenceGroups: {
    group: string;
    glyph: string;
    tone: string;
    title: string;
    hint: string;
    files: { id: string; fileName: string; status: string; verifiedFields: number; message: string | null }[];
  }[];
  descriptionDocument: {
    id: string;
    fileName: string;
    status: string;
    message: string | null;
    sizeBytes: number;
    textAvailable: boolean;
  } | null;
  /**
   * Every upload on this project, newest first, including older versions of the description
   * document. Change plan mode pairs one of these with the earlier one it replaces.
   */
  uploads: {
    id: string;
    fileName: string;
    group: string;
    uploadedAt: string;
    textAvailable: boolean;
    /** Replaced by a later upload — kept so it can be the "before" half of a comparison. */
    superseded: boolean;
  }[];
  policy: { maxFilesPerGroup: number; maxUploadMb: number };
  missingInformation: {
    id: string;
    title: string;
    description: string | null;
    priority: string;
    suggestions: string[];
    targetView: string;
  }[];
}

/**
 * A customer name read out of the uploaded documents, waiting for the PM to accept or dismiss it.
 * Never applied on its own: the wrong customer means the project is scored against the wrong
 * checklist and another company's template gets filled with it.
 */
export interface CustomerSuggestion {
  name: string;
  /** A verbatim quote from the document, so the PM can judge it without opening the file. */
  evidence: string;
  sourceLabel: string | null;
  /** Set when the name resolves to a customer already in the reference library. */
  matchedKey: string | null;
  matchedName: string | null;
  /** What the Customer field said when this was proposed — accepting replaces it. */
  replaces: string | null;
  suggestedAt: string;
}

/** What "Verify input" reports back: what it read, what it prefilled, and what it verified. */
export interface VerifyResult {
  verified: number;
  prefilled: number;
  documentsRead: number;
  stillEmpty: number;
  provider: 'anthropic' | 'mock';
  customerSuggestion: CustomerSuggestion | null;
}

export interface GovernanceAlternative {
  approach: Approach;
  score: number;
  rationale: string;
}

/**
 * One piece of evidence behind the recommendation, in both languages.
 *
 * The interface is English, so `english` is what is read. `original` is the same sentence as the
 * uploaded document writes it — kept because that is the only string a PM can search their own
 * file for — and `source` names the file it came from, shown in bold red so it is obvious at a
 * glance which document each line rests on. Snapshots taken before this shape existed are
 * normalised on the server, so `original` and `source` may be empty but the field is always there.
 */
export interface EvidenceItem {
  english: string;
  original?: string;
  source: string;
}

/** One block of the Planning Review's top panel — what the project *is*, read from its documents. */
export interface OverviewSection {
  key: string;
  label: string;
  summary: string;
  points: string[];
}

/** Something the project still lacks before it can start. */
export interface PlanningGap {
  title: string;
  why: string;
  /** The catalog document that would close it, or null. This is what the Studio filters on. */
  documentName: string | null;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** A contradiction or anomaly found across the uploaded documents. */
export interface AnalysisFinding {
  title: string;
  detail: string;
  evidence: EvidenceItem[];
}

/** One governance model scored against the nine criteria. */
export interface ScoredApproach {
  approach: Approach;
  score: number;
  reasons: string[];
  /** Always empty in PM_CHOSEN mode: the PM is not being sold a model they already picked. */
  evidence: EvidenceItem[];
  criteria: { name: string; score: number; weight: number; note: string }[];
}

export interface ApproachResponse {
  /** The latest AI governance-model recommendation (Skill 1) — the single source the
   *  approach options, and the PM decision gate, are built from. */
  evaluation: {
    id: string;
    recommendedApproach: Approach;
    confidence: number;
    confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW';
    rationale: string;
    reasons: string[];
    evidence: EvidenceItem[];
    risks: string[];
    alternatives: GovernanceAlternative[];
    summary: string | null;
    candidateValues: { fieldKey: string; label: string; value: string }[];
    /** 'mock' means the API call failed and a keyword heuristic produced this — warn the PM. */
    aiProvider: 'anthropic' | 'mock';
    createdAt: string;

    /**
     * Written by "Analyze planning needs". Snapshots from before it exists have the defaults, so
     * the Planning Review screen shows an empty overview rather than breaking on an old project.
     */
    overview: OverviewSection[];
    planningGaps: PlanningGap[];
    findings: AnalysisFinding[];
    /**
     * RECOMMENDED — the PM had not decided, so alternatives are offered and can be switched to.
     * PM_CHOSEN  — the PM named a model on Project Input; the panel scores only that one and
     * offers nothing to switch to, because there is no choice left to make here.
     */
    approachMode: 'RECOMMENDED' | 'PM_CHOSEN';
  } | null;
  options: {
    approach: Approach;
    title: string;
    tagline: string;
    summary: string;
    score: number;
    recommended: boolean;
    pack: { required: string[]; conditional: string[] };
    operatingModel: { rigor: string; controls: Record<string, string> };
  }[];
  decision: {
    id: string;
    approach: Approach;
    outcome: string;
    rigor: string;
    rationale: string | null;
    documentPack: { required: string[]; conditional: string[] };
    decidedAt: string;
    decidedBy: { name: string; initials: string };
  } | null;
}

/**
 * A fact the document needed but the project data did not have. The model wrote `token` into the
 * section text instead of guessing; "Fill out the document" swaps the answer in for that token.
 */
export interface DocumentGap {
  token: string;
  question: string;
  answer: string | null;
}

export interface RaciRow {
  activity: string;
  responsible: string;
  accountable: string;
  consulted: string;
  informed: string;
}

export interface RiskRow {
  risk: string;
  severity: string;
  owner: string;
  mitigation: string;
}

/** Tables the model returned alongside the prose, for the two documents that need one. */
/** One box on the org chart. `person` may hold a `{{gap:N}}` token — an unnamed role is normal. */
export interface OrgChartNode {
  role: string;
  person: string;
  /** The box holding decision authority in its column. */
  lead?: boolean;
}

/**
 * The org chart as data, so it can be drawn rather than described. Columns are organisations —
 * customer, partner, delivery team — laid out left to right.
 */
export interface OrgChart {
  columns: { organisation: string; groups: { name: string | null; nodes: OrgChartNode[] }[] }[];
}

export interface DocumentStructuredData {
  raciTable?: RaciRow[];
  riskRegister?: RiskRow[];
  /** The whole deliverable for an Organization Chart. */
  orgChart?: OrgChart;
  /**
   * The whole deliverable for a register document — a change log, an escalation path, a work
   * breakdown. `columns` comes from the document's own schema, so the preview never guesses it.
   */
  table?: { columns: string[]; rows: string[][] };
  /**
   * Set when this document is produced by filling a customer's own file rather than by drafting.
   * The document's sections are then placeholder → value pairs, not prose.
   */
  templateFill?: {
    templateId: string;
    customerKey: string;
    documentType: string;
    fileType: string;
    sourceFile: string;
  };
}

export interface DocumentSection {
  id: string;
  title: string;
  hint: string | null;
  required: boolean;
  included: boolean;
  order: number;
  content: string | null;
  custom: boolean;
}

export interface CatalogEntry {
  definitionId: string;
  name: string;
  domain: ManagementDomain;
  requirement: 'REQUIRED' | 'CONDITIONAL';
  conditionKey: string | null;
  /** Which real file this document downloads as. */
  exportFormat: DocumentExportFormat;
  /** Set when this document is produced by filling the customer's own file rather than drafted. */
  customerTemplate: {
    id: string;
    customerKey: string;
    customerName: string;
    documentType: string;
    fileType: 'DOCX' | 'XLSX' | 'PPTX';
    sourceFile: string;
    placeholders: TemplatePlaceholder[];
    /** False for an outline template — too few blanks to fill, so a neutral deck is built instead. */
    usableForFill: boolean;
    /** Says, in the PM's terms, what will happen and why. */
    fillNote: string;
    /**
     * True when this template comes from the house default rather than from the project's own
     * customer — the Project Plan workbook every project uses whoever the customer is. The PM is
     * entitled to know which of the two they are looking at.
     */
    house: boolean;
  } | null;
  /**
   * True when the last analysis named this document as a planning gap; `null` on every entry when
   * no analysis tied a gap to a document, which the Studio reads as "no filter to apply" and shows
   * the whole catalog.
   */
  inPlanningGap: boolean | null;
  /**
   * A register document's own columns, from its schema. Present whether or not it has been
   * generated, so the grid never borrows another document's header to stand in for a missing one.
   */
  tableColumns: string[] | null;
  document: {
    id: string;
    status: DocumentStatus;
    version: number;
    coverage: number;
    sections: DocumentSection[];
    gaps: DocumentGap[];
    structuredData: DocumentStructuredData | null;
    generatedAt: string | null;
    approvedAt: string | null;
    /** Set by an applied plan change: why this draft is out of date. A flag, not a status. */
    staleReason: string | null;
    staleSince: string | null;
  } | null;
}

// ---------------------------------------------------------------- change plan mode

export type PlanChangeStatus = 'DRAFT' | 'ANALYZED' | 'APPLIED' | 'DISMISSED';

/** One block of the project overview a change has moved. */
export interface OverviewChange {
  key: string;
  label: string;
  /** What the previous analysis said — the panel shows the movement, not just the result. */
  previous: string;
  summary: string;
  points: string[];
}

export interface AffectedDocument {
  documentName: string;
  reason: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
}

/** The delta the model returned. Everything else about a change is derived from it. */
export interface PlanChangeImpact {
  summary: string;
  changedOverview: OverviewChange[];
  newGaps: PlanningGap[];
  /** One-based positions in the previous gap list — never titles. */
  closedGaps: number[];
  newFindings: AnalysisFinding[];
  approach: { stillFits: boolean; score: number; note: string; suggested: string | null };
  affectedDocuments: AffectedDocument[];
}

/** One document in a change, with the version it replaces where it replaces one. */
export interface PlanChangeDocument {
  id: string;
  referenceId: string;
  supersedesReferenceId: string | null;
}

export interface PlanChange {
  id: string;
  note: string | null;
  /** Proposed from what has been uploaded since the last analysis; the PM adds and removes. */
  documents: PlanChangeDocument[];
  status: PlanChangeStatus;
  impact: PlanChangeImpact | null;
  createdAt: string;
  analyzedAt: string | null;
  appliedAt: string | null;
}

/** A row on the Plan history screen. */
export interface PlanChangeHistoryEntry {
  id: string;
  note: string | null;
  status: PlanChangeStatus;
  createdAt: string;
  analyzedAt: string | null;
  appliedAt: string | null;
  createdBy: { id: string; name: string; initials: string };
  documents: { fileName: string; replacesFileName: string | null }[];
  impact: PlanChangeImpact | null;
}

// ---------------------------------------------------------------- customer reference library

/** One fill-in-the-blank slot the template scanner found. */
export interface TemplatePlaceholder {
  token: string;
  occurrences: number;
  locations: string[];
  /** The token is broken across text runs, so filling it needs the runs merged first. */
  splitAcrossRuns: boolean;
}

export interface CustomerChecklistSummary {
  id: string;
  name: string;
  sourceFile: string;
  mimeType: string;
  version: number;
  active: boolean;
  parseNote: string | null;
  uploadedAt: string;
  itemCount: number;
}

export interface CustomerTemplateSummary {
  id: string;
  documentType: string;
  fileType: string;
  sourceFile: string;
  version: number;
  active: boolean;
  parseNote: string | null;
  uploadedAt: string;
  placeholders: TemplatePlaceholder[];
  placeholderCount: number;
}

export interface CustomerSummary {
  id: string;
  key: string;
  name: string;
  /** Spellings of this customer's name that a PM may type into the project's free-text field. */
  aliases: string[];
  active: boolean;
  hasLogo: boolean;
  checklists: CustomerChecklistSummary[];
  templates: CustomerTemplateSummary[];
}

export interface ChecklistItemRow {
  id: string;
  order: number;
  section: string | null;
  code: string | null;
  text: string;
  guidance: string | null;
  expected: string | null;
}

export interface ChecklistDetail extends Omit<CustomerChecklistSummary, 'itemCount'> {
  customer: { id: string; key: string; name: string };
  items: ChecklistItemRow[];
}

// ---------------------------------------------------------------- checklist readiness

/**
 * The real file a planning document downloads as. The server decides it — a RACI document is a
 * spreadsheet, a document filled from a customer's own template is whatever that template is, and
 * everything else is Word — so the client only ever labels the button.
 */
export type DocumentExportFormat = 'DOCX' | 'XLSX' | 'PPTX';

/**
 * How a project's free-text Customer field was matched to the library, weakest last.
 * `default` means nothing recognised it and the house-default customer took it — which is not
 * the same as knowing who the customer is, and the UI must not present it as if it were.
 */
export type MatchConfidence = 'exact' | 'prefix' | 'partial' | 'default';

export type ChecklistStatus = 'MET' | 'PARTIAL' | 'NOT_MET' | 'NOT_APPLICABLE' | 'UNKNOWN';
export type AssessmentSource = 'DETERMINISTIC' | 'AI' | 'PM';

export interface ChecklistScore {
  score: number;
  applicable: number;
  assessed: number;
  met: number;
  partial: number;
  notMet: number;
  unknown: number;
  notApplicable: number;
  /** How much of the checklist has been looked at — the score's own confidence. */
  coverage: number;
}

export interface ChecklistAssessedItem {
  id: string;
  order: number;
  section: string | null;
  text: string;
  guidance: string | null;
  /**
   * The English readings, written once when the checklist was uploaded. The interface is English,
   * so these are what the screen shows, with the customer's own wording kept beneath — that is the
   * string a PM quotes back at the audit. Null when the source is already English, or when no
   * model was available to translate; the UI then shows the original alone.
   */
  sectionEn: string | null;
  textEn: string | null;
  guidanceEn: string | null;
  status: ChecklistStatus;
  source: AssessmentSource | null;
  evidence: string | null;
  note: string | null;
}

export type ChecklistReadiness =
  | { applies: false; typedCustomer: string | null; reason: string }
  | {
      applies: true;
      customer: { id: string; key: string; name: string };
      match: { confidence: MatchConfidence; matchedOn: string; typed: string | null };
      checklist: { id: string; name: string; version: number; sourceFile: string };
      assessment: {
        assessedAt: string | null;
        stale: boolean;
        runState: string;
        lastError: string | null;
        aiProvider: string;
      };
      score: ChecklistScore;
      items: ChecklistAssessedItem[];
      sections: (ChecklistScore & { section: string; sectionEn: string | null; total: number })[];
    };

export interface StudioResponse {
  catalog: CatalogEntry[];
  domains: { domain: ManagementDomain; count: number }[];
}

/** One chat thread, private to the user who held it. */
export interface AgentSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

export interface AgentMessage {
  id: string;
  role: 'USER' | 'AGENT';
  content: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
}
