import { api } from './client';
import type {
  AgentMessage,
  ApproachResponse,
  Approach,
  DashboardResponse,
  InputProfile,
  ManagementDomain,
  PortfolioOverview,
  ProjectTeamMember,
  ProjectType,
  StudioResponse,
  User,
  Workspace,
} from './types';

export const authApi = {
  login: (email: string, password: string) => api.post<{ token: string; user: User }>('/auth/login', { email, password }),
  register: (body: { email: string; name: string; password: string; jobTitle?: string }) =>
    api.post<{ token: string; user: User }>('/auth/register', body),
  me: () => api.get<{ user: User }>('/auth/me'),
};

export const portfolioApi = {
  list: () => api.get<{ portfolios: { id: string; name: string }[] }>('/portfolios'),
  overview: (portfolioId: string) => api.get<PortfolioOverview>(`/portfolios/${portfolioId}/overview`),
  createPortfolio: (body: { name: string; businessUnit?: string; strategicObjective?: string }) =>
    api.post<{ id: string; name: string }>('/portfolios', body),
  createProgram: (portfolioId: string, body: { name: string; description?: string; targetOutcome?: string }) =>
    api.post<{ id: string; name: string; key: string }>(`/portfolios/${portfolioId}/programs`, body),
  createProject: (
    portfolioId: string,
    body: { name: string; type: ProjectType; programId?: string | null; customer?: string; targetStart?: string },
  ) => api.post<Workspace>(`/portfolios/${portfolioId}/projects`, body),
};

export const projectApi = {
  workspace: (projectId: string) => api.get<Workspace>(`/projects/${projectId}`),
  dashboard: (projectId: string) => api.get<DashboardResponse>(`/projects/${projectId}/dashboard`),
  saveLayout: (projectId: string, widgets: Record<string, boolean>) =>
    api.put(`/projects/${projectId}/dashboard/layout`, { widgets }),
  members: (projectId: string) => api.get<{ members: ProjectTeamMember[] }>(`/projects/${projectId}/members`),
  addMember: (projectId: string, body: { email: string; role?: string }) =>
    api.post<ProjectTeamMember>(`/projects/${projectId}/members`, body),
  removeMember: (projectId: string, userId: string) => api.delete(`/projects/${projectId}/members/${userId}`),
};

export const inputApi = {
  profile: (projectId: string) => api.get<InputProfile>(`/projects/${projectId}/input`),
  save: (projectId: string, values: { definitionId: string; value: string | null }[]) =>
    api.put<InputProfile>(`/projects/${projectId}/input`, { values }),
  verify: (projectId: string) => api.post<{ verified: number }>(`/projects/${projectId}/input/verify`),
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
  setContract: (
    projectId: string,
    body: {
      definitionId: string;
      templateId: string;
      sections?: { title: string; hint?: string; required?: boolean; included?: boolean; custom?: boolean }[];
    },
  ) => api.post(`/projects/${projectId}/documents/contract`, body),
  generate: (projectId: string, documentId: string) =>
    api.post(`/projects/${projectId}/documents/${documentId}/generate`),
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
  messages: (projectId: string) => api.get<{ messages: AgentMessage[] }>(`/projects/${projectId}/agent/messages`),
  ask: (projectId: string, question: string) =>
    api.post<{ agentMessage: AgentMessage }>(`/projects/${projectId}/agent/messages`, { question }),
};
