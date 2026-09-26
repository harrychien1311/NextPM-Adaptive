import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { planChangeApi, projectApi } from '../api/endpoints';
import { useAuth } from '../store/auth';
import { DashboardView } from './workspace/DashboardView';
import { InputView } from './workspace/InputView';
// The view keeps the `approach` route key so existing links and saved state survive the rename to
// Planning Assessment — the same reason `ApproachView` kept its filename when it became a screen
// about governance models.
import { PlanningAssessmentView } from './workspace/PlanningAssessmentView';
import { UpdatePlanningView } from './workspace/UpdatePlanningView';
import { PlanHistoryView } from './workspace/PlanHistoryView';
import { PmActionsView } from './workspace/PmActionsView';
import { StudioView } from './workspace/StudioView';
import { AgentDrawer } from './workspace/AgentDrawer';
import { FloatingAgentButton } from './workspace/FloatingAgentButton';
import { TeamModal } from './workspace/TeamModal';
import { SignOutIcon } from '../components/icons';

/**
 * The planning flow is five steps: Project Input, Planning Assessment, Planning Documents, then —
 * once the PM has confirmed the assessment — Update Planning (`update`) and Plan History
 * (`history`). The last two stay out of the sidebar until then: before a plan is confirmed there is
 * nothing to change and no history to read.
 *
 * `actions` is the full PM Actions list, reached from the dashboard's "View all" — a view, not a
 * step in the flow.
 */
export type WorkspaceView = 'dashboard' | 'input' | 'approach' | 'studio' | 'update' | 'history' | 'actions';

/**
 * Switching view, optionally naming the document to land on.
 *
 * Most callers pass a view alone. The dashboard's PM action center passes the second argument,
 * because "Open" on an action that says *the Risk Management Plan is missing* has to arrive at that
 * document — landing on whichever one the Studio would have picked for itself makes every action on
 * the list open the same screen, which is what it did before this existed.
 */
export type NavigateToView = (view: WorkspaceView, focusDocument?: string | null) => void;
// The same second argument names a Planning Assessment tab for `approach` (e.g. 'fit'), so the
// dashboard's "View rationale" lands on Methodology Fit. The sidebar navigates through `goToView`
// too, with no focus, so a stale one can never reopen a tab or document nobody asked for.

/** The values `?view=` accepts, so a hand-edited URL cannot put the workspace in a state that isn't one. */
const WORKSPACE_VIEWS: WorkspaceView[] = ['dashboard', 'input', 'approach', 'studio', 'update', 'history', 'actions'];

export function WorkspacePage({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  /**
   * A brand-new project opens on Project Input, not on the dashboard: there is nothing to report
   * yet, and the first thing its owner has to do is upload the document the analysis reads. The
   * create dialog says so with `?view=input`; every other way in still lands on the dashboard.
   */
  const [searchParams] = useSearchParams();
  const requested = searchParams.get('view');
  const [view, setView] = useState<WorkspaceView>(
    requested && WORKSPACE_VIEWS.includes(requested as WorkspaceView) ? (requested as WorkspaceView) : 'dashboard',
  );
  const [agentOpen, setAgentOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);

  /**
   * The document the next screen should open on, when the caller named one.
   *
   * Cleared on every navigation that does not name one, so a later plain "go to the Studio" does not
   * silently reopen whatever an action pointed at half an hour ago.
   */
  const [focusDocument, setFocusDocument] = useState<string | null>(null);
  const goToView: NavigateToView = (next, focus = null) => {
    setFocusDocument(focus);
    setView(next);
  };

  const workspace = useQuery({
    queryKey: ['workspace', projectId],
    queryFn: () => projectApi.workspace(projectId),
  });

  /** The change the PM currently has open, if any — the sidebar marks step 4 while there is one. */
  const planChange = useQuery({
    queryKey: ['plan-change', projectId],
    queryFn: () => planChangeApi.current(projectId),
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
        This project could not be loaded, or you have not been granted access to it.
        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="secondary" onClick={() => navigate('/')}>
            ← Back to program overview
          </button>
          <button className="secondary" onClick={logout}>
            Sign out
          </button>
        </div>
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
              <strong>NEXTFIT AI</strong>
              <span>Adaptive Planning Agent</span>
            </div>
          </div>
          <button className="back-projects" onClick={() => navigate('/')}>
            ← Program overview
          </button>
          <div className="workspace-path">
            <span>Program</span>
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
              onClick={() => goToView('dashboard')}
            >
              <span className="nav-icon">▦</span>
              <span>Dashboard</span>
            </button>
            <div className="flow-label">PROJECT PLANNING FLOW</div>
            <div className="planning-flow-nav">
              <button className={`nav-item${view === 'input' ? ' active' : ''}`} onClick={() => goToView('input')}>
                <span className="step-node">1</span>
                <span>Project Input</span>
              </button>
              <button className={`nav-item${view === 'approach' ? ' active' : ''}`} onClick={() => goToView('approach')}>
                <span className="step-node">2</span>
                <span>Planning Assessment</span>
                {project.approach ? <b>✓</b> : <i>!</i>}
              </button>
              <button className={`nav-item${view === 'studio' ? ' active' : ''}`} onClick={() => goToView('studio')}>
                <span className="step-node">3</span>
                <span>Planning Documents</span>
                <b>
                  {project.documentsGenerated}/{project.documentsTotal || 0}
                </b>
              </button>
              {/*
                Steps 4 and 5 appear once the PM has confirmed the Planning Assessment. Before that
                there is no plan to change and no history of one, and two steps that lead nowhere would
                only invite the PM to click into an empty screen.
              */}
              {project.approach && (
                <>
                  <button className={`nav-item${view === 'update' ? ' active' : ''}`} onClick={() => goToView('update')}>
                    <span className="step-node">4</span>
                    <span>Update Planning</span>
                    {planChange.data?.change && <i title="A change is being recorded">●</i>}
                  </button>
                  <button className={`nav-item${view === 'history' ? ' active' : ''}`} onClick={() => goToView('history')}>
                    <span className="step-node">5</span>
                    <span>Plan History</span>
                  </button>
                </>
              )}
            </div>
          </nav>

          <div className="side-spacer" />
          <div className="agent-card">
            <div className="agent-orb">✦</div>
            <strong>Planning Agent</strong>
            <span>Advisory</span>
            <small>AI verifies, recommends and drafts. PM confirms every decision and baseline.</small>
            <button onClick={() => setAgentOpen(true)}>Open agent</button>
          </div>
          <div className="profile">
            <div className="avatar">{user?.initials}</div>
            <div>
              <strong>{user?.name}</strong>
              <span>{user?.jobTitle}</span>
            </div>
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
              {project.documentsInReview > 0 && (
                <button className="primary small" onClick={() => goToView('studio')}>
                  Review {project.documentsInReview} draft{project.documentsInReview > 1 ? 's' : ''}
                </button>
              )}
              {/* Sign out sits last so it is the top-right corner on every screen of the app. */}
              <button className="icon-button signout-button" onClick={logout} title="Sign out" aria-label="Sign out">
                <SignOutIcon />
              </button>
            </div>
          </header>

          {/*
            Said once, plainly, instead of leaving a reader to discover it one greyed-out button at
            a time. The controls are disabled either way; this explains why.
          */}
          {project.projectRole !== null && project.projectRole !== 'OWNER' && (
            <div className="read-only-banner">
              <span>👁</span>
              <p>
                <strong>View-only access.</strong> You can read everything in this project and download its
                documents, but saving inputs, generating documents and approving them are reserved for the project
                owner.
              </p>
            </div>
          )}

          {view === 'dashboard' && <DashboardView projectId={projectId} onNavigate={goToView} />}
          {view === 'input' && <InputView projectId={projectId} onNavigate={goToView} />}
          {view === 'approach' && (
            <PlanningAssessmentView projectId={projectId} onNavigate={goToView} initialTab={focusDocument} />
          )}
          {view === 'studio' && <StudioView projectId={projectId} focusDocument={focusDocument} />}
          {/*
            Update Planning holds the whole change — record, analyse, then the impact to apply or
            dismiss — and picks which from the change's own status, so a refresh lands on the right
            step. It used to be split between Project Input and the assessment route.
          */}
          {view === 'update' && <UpdatePlanningView projectId={projectId} onNavigate={goToView} />}
          {view === 'history' && <PlanHistoryView projectId={projectId} onNavigate={goToView} />}
          {view === 'actions' && <PmActionsView projectId={projectId} onNavigate={goToView} />}
        </main>
      </div>

      {!agentOpen && <FloatingAgentButton onOpen={() => setAgentOpen(true)} />}
      <AgentDrawer projectId={projectId} open={agentOpen} onClose={() => setAgentOpen(false)} />
      <TeamModal projectId={projectId} open={teamOpen} onClose={() => setTeamOpen(false)} />
    </>
  );
}
