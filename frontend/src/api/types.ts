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
  | 'RISK';
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
  readiness: number;
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
  phaseLabel: string;
  program: { id: string; name: string; key: string } | null;
  members: { id: string; name: string; initials: string }[];
  approach: { approach: Approach; rigor: string; outcome: string; decidedAt: string } | null;
  recommendation: { approach: Approach; confidence: number } | null;
  readiness: number;
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
  priority: 'REQUIRED' | 'CONDITIONAL' | 'INFO';
  domain: ManagementDomain;
  title: string;
  description: string | null;
  targetView: 'input' | 'approach' | 'studio';
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

/** What "Verify input" reports back: what it read, what it prefilled, and what it verified. */
export interface VerifyResult {
  verified: number;
  prefilled: number;
  documentsRead: number;
  stillEmpty: number;
  provider: 'anthropic' | 'mock';
}

export interface GovernanceAlternative {
  approach: Approach;
  score: number;
  rationale: string;
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
    evidence: string[];
    risks: string[];
    alternatives: GovernanceAlternative[];
    summary: string | null;
    candidateValues: { fieldKey: string; label: string; value: string }[];
    /** 'mock' means the API call failed and a keyword heuristic produced this — warn the PM. */
    aiProvider: 'anthropic' | 'mock';
    createdAt: string;
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
export interface DocumentStructuredData {
  raciTable?: RaciRow[];
  riskRegister?: RiskRow[];
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
  } | null;
}

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
