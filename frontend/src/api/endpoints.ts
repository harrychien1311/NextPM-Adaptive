import { api } from './client';
import type {
  AdminAccountList,
  AgentMessage,
  AgentSession,
  ApproachResponse,
  Approach,
  ChecklistDetail,
  ChecklistReadiness,
  ChecklistStatus,
  CustomerSummary,
  DashboardResponse,
  DocumentExportFormat,
  DocumentGap,
  DocumentSection,
  DocumentStatus,
  DocumentStructuredData,
  InputProfile,
  ManagementDomain,
  ProgramOverview,
  ProjectRole,
  ProjectStatus,
  ProjectTeamMember,
  ProjectType,
  ReferenceDetail,
  Role,
  StudioResponse,
  User,
  VerifyResult,
  Workspace,
} from './types';

export const authApi = {
  login: (email: string, password: string) => api.post<{ token: string; user: User }>('/auth/login', { email, password }),
  register: (body: { email: string; name: string; password: string; jobTitle?: string }) =>
    api.post<{ token: string; user: User }>('/auth/register', body),
  me: () => api.get<{ user: User }>('/auth/me'),
};

/**
 * The customer reference library — each customer's checklists and document templates, uploaded
 * once and reused by every project for them. Readable by any delivery account; only a program
 * owner or an administrator may change it.
 */
export const customersApi = {
  list: () => api.get<{ customers: CustomerSummary[] }>('/customers'),
  create: (body: { name: string; key?: string; aliases?: string[] }) => api.post<CustomerSummary>('/customers', body),
  update: (customerId: string, body: { name?: string; aliases?: string[]; active?: boolean }) =>
    api.patch<CustomerSummary>(`/customers/${customerId}`, body),
  remove: (customerId: string) => api.delete<{ deleted: boolean }>(`/customers/${customerId}`),

  uploadChecklist: (customerId: string, file: File, name: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('name', name);
    return api.upload<{ id: string; version: number; itemCount: number; parsed: string }>(
      `/customers/${customerId}/checklists`,
      form,
    );
  },
  checklistItems: (checklistId: string) => api.get<ChecklistDetail>(`/customers/checklists/${checklistId}/items`),
  removeChecklist: (checklistId: string) => api.delete<{ deleted: boolean }>(`/customers/checklists/${checklistId}`),

  uploadTemplate: (customerId: string, file: File, documentType: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('documentType', documentType);
    return api.upload<{ id: string; version: number; parseNote: string }>(`/customers/${customerId}/templates`, form);
  },
  removeTemplate: (templateId: string) => api.delete<{ deleted: boolean }>(`/customers/templates/${templateId}`),

  uploadLogo: (customerId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.upload<CustomerSummary>(`/customers/${customerId}/logo`, form);
  },

  /** Downloads the stored original, so the parse can be checked against the real file. */
  downloadChecklist: (checklistId: string, fileName: string) =>
    api.download(`/customers/checklists/${checklistId}/file`, fileName),
  downloadTemplate: (templateId: string, fileName: string) =>
    api.download(`/customers/templates/${templateId}/file`, fileName),
};

export const programApi = {
  /** The delivery landing screen — programs, their projects, and what this account may do. */
  overview: () => api.get<ProgramOverview>('/programs/overview'),
  create: (body: { name: string; description?: string; targetOutcome?: string }) =>
    api.post<{ id: string; name: string; key: string }>('/programs', body),
  /** Placed on programApi below; see rulesApi for the planning analysis. */
  update: (programId: string, body: { name?: string; description?: string | null; targetOutcome?: string | null }) =>
    api.patch<{ id: string; name: string; key: string }>(`/programs/${programId}`, body),
  /** Does not delete the program's projects — they become standalone. */
  remove: (programId: string) =>
    api.delete<{ deleted: boolean; name: string; projectsReleased: number }>(`/programs/${programId}`),
};

/** Administrator console — account management only. */
export const adminApi = {
  users: () => api.get<AdminAccountList>('/admin/users'),
  createUser: (body: { email: string; name: string; password: string; jobTitle?: string; role: Role }) =>
    api.post('/admin/users', body),
  updateUser: (userId: string, body: { name?: string; jobTitle?: string; role?: Role; active?: boolean }) =>
    api.patch(`/admin/users/${userId}`, body),
  resetPassword: (userId: string, password: string) => api.post(`/admin/users/${userId}/password`, { password }),
  deleteUser: (userId: string) => api.delete(`/admin/users/${userId}`),
};

export const projectApi = {
  create: (body: {
    name: string;
    type: ProjectType;
    programId?: string | null;
    customer?: string;
    targetStart?: string;
  }) => api.post<Workspace>('/projects', body),
  workspace: (projectId: string) => api.get<Workspace>(`/projects/${projectId}`),
  update: (
    projectId: string,
    body: {
      name?: string;
      status?: ProjectStatus;
      summary?: string;
      customer?: string;
      targetLabel?: string;
      programId?: string | null;
      /** Changing it changes which input schema and which document catalog apply. */
      type?: ProjectType;
      /** null = "not decided yet", which is what asks the analysis to recommend a model. */
      preferredApproach?: string | null;
    },
  ) => api.patch<Workspace>(`/projects/${projectId}`, body),
  /** Irreversible — cascades every input, upload, document and audit row of the project. */
  remove: (projectId: string) =>
    api.delete<{ deleted: boolean; name: string; documentsRemoved: number }>(`/projects/${projectId}`),
  dashboard: (projectId: string) => api.get<DashboardResponse>(`/projects/${projectId}/dashboard`),
  saveLayout: (projectId: string, widgets: Record<string, boolean>) =>
    api.put(`/projects/${projectId}/dashboard/layout`, { widgets }),
  members: (projectId: string) => api.get<{ members: ProjectTeamMember[] }>(`/projects/${projectId}/members`),
  addMember: (projectId: string, body: { email: string; role?: ProjectRole }) =>
    api.post<ProjectTeamMember>(`/projects/${projectId}/members`, body),
  removeMember: (projectId: string, userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
};

export const inputApi = {
  profile: (projectId: string) => api.get<InputProfile>(`/projects/${projectId}/input`),
  save: (projectId: string, values: { definitionId: string; value: string | null }[]) =>
    api.put<InputProfile>(`/projects/${projectId}/input`, { values }),
  /** Extracts from the uploaded documents, prefills what it can, then verifies the PM's answers. */
  verify: (projectId: string) => api.post<VerifyResult>(`/projects/${projectId}/input/verify`),
  /**
   * The PM's decision on the customer read from the documents. Accepting sets `Project.customer`,
   * which is what unlocks that customer's checklist and templates; `value` lets the PM correct the
   * proposed name first.
   */
  resolveCustomerSuggestion: (projectId: string, action: 'accept' | 'dismiss', value?: string) =>
    api.post<{ customer: string | null; suggestion: null }>(
      `/projects/${projectId}/input/customer-suggestion`,
      { action, ...(value ? { value } : {}) },
    ),
  addCustomField: (projectId: string, body: { name: string; value?: string; useIn?: string }) =>
    api.post(`/projects/${projectId}/custom-fields`, body),
  removeCustomField: (projectId: string, id: string) => api.delete(`/projects/${projectId}/custom-fields/${id}`),
  resolveAction: (projectId: string, actionId: string, value: string) =>
    api.post(`/projects/${projectId}/actions/${actionId}/resolve`, { value }),
  uploadReference: (projectId: string, group: string, file: File) => {
    const form = new FormData();
    form.append('group', group);
    form.append('file', file);
    return api.upload(`/projects/${projectId}/references`, form);
  },
  uploadDescription: (projectId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.upload(`/projects/${projectId}/description`, form);
  },
  removeReference: (projectId: string, id: string) => api.delete(`/projects/${projectId}/references/${id}`),
  /** Metadata + the text extracted on upload, for the preview panel. */
  reference: (projectId: string, id: string) =>
    api.get<ReferenceDetail>(`/projects/${projectId}/references/${id}`),
  /** Absolute URL of the original file, for "open the real thing" links. */
  referenceFileUrl: (projectId: string, id: string) =>
    `${import.meta.env.VITE_API_URL ?? '/api'}/projects/${projectId}/references/${id}/file`,
};

export const rulesApi = {
  approach: (projectId: string) => api.get<ApproachResponse>(`/projects/${projectId}/approach`),
  /** Skill 1: asks the AI to recommend a governance model from verified inputs + the project description document. */
  evaluate: (projectId: string) => api.post(`/projects/${projectId}/approach/evaluate`),
  /**
   * "Analyze planning needs" — the single call behind Planning Review. Reads every uploaded
   * document plus what the PM typed and returns the overview, the approach advisory, the planning
   * gaps and the document findings as one snapshot. No offline fallback: it fails rather than
   * inventing.
   */
  analyze: (projectId: string) => api.post(`/projects/${projectId}/planning/analyze`),
  decide: (projectId: string, body: { approach: Approach; outcome?: 'CONFIRMED' | 'OVERRIDDEN'; rationale?: string }) =>
    api.post(`/projects/${projectId}/approach/decide`, body),
};

export const documentsApi = {
  studio: (projectId: string, domain?: ManagementDomain) =>
    api.get<StudioResponse>(`/projects/${projectId}/documents${domain ? `?domain=${domain}` : ''}`),
  fit: (projectId: string, definitionId: string) => api.get(`/projects/${projectId}/documents/${definitionId}/fit`),
  /** One generated document by id — what the dashboard's Planning documents list previews. */
  detail: (projectId: string, documentId: string) =>
    api.get<{
      id: string;
      name: string;
      version: number;
      status: DocumentStatus;
      sections: DocumentSection[];
      gaps: DocumentGap[];
      structuredData: DocumentStructuredData | null;
      // Was 'DOCX' | 'XLSX' — a type that had stopped being true once decks and charts became
      // spreadsheets' neighbours. The server has always been the one deciding this.
      exportFormat: DocumentExportFormat;
      /** A register's own columns — present whether or not the document has been generated. */
      tableColumns: string[] | null;
    }>(`/projects/${projectId}/documents/${documentId}`),
  /**
   * The slides of the deck this document downloads as, read out of the real rendered file. Used by
   * the preview so a deck previews as the deck — including one filled from a customer's own
   * template, whose slides live in their file and nowhere else.
   */
  slides: (projectId: string, documentId: string) =>
    api.get<{
      fileName: string;
      template: { customerKey: string; sourceFile: string } | null;
      slides: { number: number; lines: string[]; pictures: number; hasTable: boolean }[];
    }>(`/projects/${projectId}/documents/${documentId}/slides`),
  /**
   * The same, for a document filled from a customer's workbook: the real sheets of the real file.
   * `merges` is 0-based against `rows`, so the grid can span the cells the workbook spans.
   */
  sheets: (projectId: string, documentId: string) =>
    api.get<{
      fileName: string;
      template: { customerKey: string; sourceFile: string };
      sheets: {
        name: string;
        rows: string[][];
        merges: { row: number; col: number; rowSpan: number; colSpan: number }[];
        truncated: boolean;
      }[];
    }>(`/projects/${projectId}/documents/${documentId}/sheets`),
  /** The model chooses the structure — there is no template or section contract to set first. */
  generate: (projectId: string, definitionId: string) =>
    api.post(`/projects/${projectId}/documents/generate`, { definitionId }),
  /** "Edit content" — replaces the draft with the PM's own text. */
  saveSections: (projectId: string, documentId: string, sections: { title: string; content: string }[]) =>
    api.put(`/projects/${projectId}/documents/${documentId}/sections`, { sections }),
  /** Records one answer; nothing is written into the document until `fill`. */
  answerGap: (projectId: string, documentId: string, token: string, answer: string) =>
    api.post(`/projects/${projectId}/documents/${documentId}/gaps`, { token, answer }),
  /** Substitutes every answered gap into the blanks it belongs to. */
  fill: (projectId: string, documentId: string) => api.post(`/projects/${projectId}/documents/${documentId}/fill`),
  approve: (projectId: string, documentId: string) =>
    api.post(`/projects/${projectId}/documents/${documentId}/approve`),
  export: (projectId: string, format: 'DOCX' | 'XLSX' | 'PDF' | 'CONFLUENCE') =>
    api.post(`/projects/${projectId}/exports`, { format }),
  /**
   * One download for every document — the server chooses `.docx` or `.xlsx` and says so in the
   * response headers. `format` only shapes the fallback name used when those headers are missing.
   */
  download: (projectId: string, documentId: string, name: string, format: DocumentExportFormat = 'DOCX') =>
    api.download(`/projects/${projectId}/documents/${documentId}/export`, `${name}.${format.toLowerCase()}`),
};

/**
 * How far a project meets what its customer's checklist requires — the readiness number the
 * customer would actually ask about, as opposed to how full our own input form is.
 */
export const checklistApi = {
  readiness: (projectId: string) => api.get<ChecklistReadiness>(`/projects/${projectId}/checklist`),
  /** Re-runs the assessment and waits. `onlyUnmet` skips items already met, which is much cheaper. */
  assess: (projectId: string, onlyUnmet = false) =>
    api.post<{ readiness: ChecklistReadiness; sentToModel: number; provider: string }>(
      `/projects/${projectId}/checklist/assess`,
      { onlyUnmet },
    ),
  /** The PM's own verdict on one item — outranks the deterministic pass and the model. */
  setItem: (projectId: string, itemId: string, status: ChecklistStatus, note?: string) =>
    api.post<ChecklistReadiness>(`/projects/${projectId}/checklist/items/${itemId}`, { status, note }),
};

export const dashboardExportApi = {
  downloadHtml: (projectId: string) => api.download(`/projects/${projectId}/dashboard/export.html`, 'dashboard.html'),
};

export const agentApi = {
  sessions: (projectId: string) =>
    api.get<{ sessions: AgentSession[] }>(`/projects/${projectId}/agent/sessions`),
  createSession: (projectId: string) => api.post<AgentSession>(`/projects/${projectId}/agent/sessions`),
  messages: (projectId: string, sessionId: string) =>
    api.get<{ messages: AgentMessage[] }>(`/projects/${projectId}/agent/sessions/${sessionId}/messages`),
  /** Asks inside one thread — the backend replays that thread's earlier turns to the model. */
  ask: (projectId: string, sessionId: string, question: string) =>
    api.post<{ agentMessage: AgentMessage; title: string }>(
      `/projects/${projectId}/agent/sessions/${sessionId}/messages`,
      { question },
    ),
  renameSession: (projectId: string, sessionId: string, title: string) =>
    api.patch<AgentSession>(`/projects/${projectId}/agent/sessions/${sessionId}`, { title }),
  deleteSession: (projectId: string, sessionId: string) =>
    api.delete(`/projects/${projectId}/agent/sessions/${sessionId}`),
};
