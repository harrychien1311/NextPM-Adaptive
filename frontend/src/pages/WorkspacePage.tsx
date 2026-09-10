import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { projectApi } from '../api/endpoints';
import { useAuth } from '../store/auth';
import { DashboardView } from './workspace/DashboardView';
import { InputView } from './workspace/InputView';
import { ApproachView } from './workspace/ApproachView';
import { StudioView } from './workspace/StudioView';
import { AgentDrawer } from './workspace/AgentDrawer';
import { TeamModal } from './workspace/TeamModal';

export type WorkspaceView = 'dashboard' | 'input' | 'approach' | 'studio';

export function WorkspacePage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [view, setView] = useState<WorkspaceView>('dashboard');
  const [agentOpen, setAgentOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);

  const workspace = useQuery({
    queryKey: ['workspace', projectId],
    queryFn: () => projectApi.workspace(projectId),
  });

  if (workspace.isLoading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Opening project workspace…
      </div>
    );
  }
  if (workspace.isError || !workspace.data) {
    return (
      <div className="state-block">
        <strong>Workspace unavailable</strong>
        This project could not be loaded. Return to the portfolio overview and try again.
      </div>
    );
  }

  const project = workspace.data;
  const typeClass = project.type.toLowerCase();

  return (
    <>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">N</div>
            <div>
              <strong>NextPM</strong>
              <span>Adaptive</span>
            </div>
          </div>
          <button className="back-projects" onClick={() => navigate('/')}>
            ← Portfolio overview
          </button>
          <div className="workspace-path">
            <span>Portfolio</span>
            <b>›</b>
            <strong>{project.program?.name ?? 'Standalone'}</strong>
          </div>
          <div className="workspace-identity">
            <span className={`project-type ${typeClass}`}>{project.type}</span>
            <div>
              <strong>{project.name}</strong>
              <small>Project workspace</small>
            </div>
          </div>

          <button className="team-trigger" onClick={() => setTeamOpen(true)}>
            <span className="avatar-stack">
              {project.members.slice(0, 4).map((member) => (
                <span key={member.id}>{member.initials}</span>
              ))}
            </span>
            <span>
              Team · {project.members.length} member{project.members.length === 1 ? '' : 's'}
            </span>
          </button>

          <nav aria-label="Primary navigation">
            <button
              className={`nav-item overview-item${view === 'dashboard' ? ' active' : ''}`}
              onClick={() => setView('dashboard')}
            >
              <span className="nav-icon">▦</span>
              <span>Dashboard</span>
            </button>
            <div className="flow-label">PROJECT PLANNING FLOW</div>
            <div className="planning-flow-nav">
              <button className={`nav-item${view === 'input' ? ' active' : ''}`} onClick={() => setView('input')}>
                <span className="step-node">1</span>
                <span>Project Input</span>
                <b>{project.inputReadiness}%</b>
              </button>
              <button className={`nav-item${view === 'approach' ? ' active' : ''}`} onClick={() => setView('approach')}>
                <span className="step-node">2</span>
                <span>Governance Model</span>
                {project.approach ? <b>✓</b> : <i>!</i>}
              </button>
              <button className={`nav-item${view === 'studio' ? ' active' : ''}`} onClick={() => setView('studio')}>
                <span className="step-node">3</span>
                <span>Planning Studio</span>
                <b>
                  {project.documentsGenerated}/{project.documentsTotal || 0}
                </b>
              </button>
            </div>
          </nav>

          <div className="side-spacer" />
          <div className="agent-card">
            <div className="agent-orb">✦</div>
            <strong>Planning Agent</strong>
            <span>Copilot Studio</span>
            <small>AI verifies, recommends and drafts. PM confirms every decision and baseline.</small>
            <button onClick={() => setAgentOpen(true)}>Open agent</button>
          </div>
          <div className="profile">
            <div className="avatar">{user?.initials}</div>
            <div>
              <strong>{user?.name}</strong>
              <span>{user?.jobTitle}</span>
            </div>
            <button aria-label="Profile menu">•••</button>
          </div>
        </aside>

        <main>
          <header className="topbar">
            <div className="project-switcher">
              <span className="status-dot" />
              <div>
                <small>{project.phaseLabel}</small>
                <strong>{project.name}</strong>
              </div>
              <span>⌄</span>
            </div>
            <div className="workflow-rail" aria-label="Project planning workflow">
              <span className={project.inputReadiness > 0 ? 'done' : ''}>
                1 <em>Input</em>
              </span>
              <b />
              <span className={project.verifiedInputs > 0 ? 'done' : ''}>
                2 <em>Verify</em>
              </span>
              <b />
              <span className={project.approach ? 'done' : ''}>
                3 <em>PM confirm</em>
              </span>
              <b />
              <span className={project.documentsGenerated > 0 ? 'done' : project.approach ? 'current' : ''}>
                4 <em>Generate</em>
              </span>
              <b />
              <span className={project.documentsApproved > 0 ? 'done' : ''}>
                5 <em>Approve</em>
              </span>
            </div>
            <div className="top-actions">
              <button className="icon-button" aria-label="Notifications">
                ◔<i />
              </button>
              {project.documentsInReview > 0 && (
                <button className="primary small" onClick={() => setView('studio')}>
                  Review {project.documentsInReview} draft{project.documentsInReview > 1 ? 's' : ''}
                </button>
              )}
            </div>
          </header>

          {view === 'dashboard' && <DashboardView projectId={projectId} onNavigate={setView} />}
          {view === 'input' && <InputView projectId={projectId} onNavigate={setView} />}
          {view === 'approach' && <ApproachView projectId={projectId} onNavigate={setView} />}
          {view === 'studio' && <StudioView projectId={projectId} />}
        </main>
      </div>

      {!agentOpen && (
        <button className="floating-agent" onClick={() => setAgentOpen(true)}>
          <span>✦</span>
          <div>
            <strong>Ask Planning Agent</strong>
            <small>Copilot Studio</small>
          </div>
        </button>
      )}
      <AgentDrawer projectId={projectId} open={agentOpen} onClose={() => setAgentOpen(false)} />
      <TeamModal projectId={projectId} open={teamOpen} onClose={() => setTeamOpen(false)} />
    </>
  );
}
