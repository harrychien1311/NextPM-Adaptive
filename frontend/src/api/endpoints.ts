import { api } from './client';
import type {
  AdminAccountList,
  AgentMessage,
  AgentSession,
  ApproachResponse,
  Approach,
  DashboardResponse,
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

export const programApi = {
  /** The delivery landing screen — programs, their projects, and what this account may do. */
  overview: () => api.get<ProgramOverview>('/programs/overview'),
  create: (body: { name: string; description?: string; targetOutcome?: string }) =>
    api.post<{ id: string; name: string; key: string }>('/programs', body),
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
    }>(`/projects/${projectId}/documents/${documentId}`),
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
  downloadDocx: (projectId: string, documentId: string, name: string) =>
    api.download(`/projects/${projectId}/documents/${documentId}/export.docx`, `${name}.docx`),
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
