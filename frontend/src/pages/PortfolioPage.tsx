import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { portfolioApi } from '../api/endpoints';
import type { ProjectCard, ProjectType } from '../api/types';
import { useAuth } from '../store/auth';
import { useToast } from '../components/Toast';
import { Backdrop, ModalShell } from '../components/Modal';

const STATUS_META: Record<string, { className: string; label: string }> = {
  ACTIVE: { className: 'active-status', label: '● Active' },
  DRAFT: { className: 'draft-status', label: '○ Draft' },
  HOLD: { className: 'hold-status', label: 'Ⅱ On hold' },
  CLOSED: { className: 'closed-status', label: '✓ Closed' },
};

const TYPE_LABEL: Record<ProjectType, string> = { SI: 'SI', SM: 'SM', PRODUCT: 'PRODUCT' };
const HEALTH_LABEL: Record<string, { className: string; label: string }> = {
  good: { className: 'health-good', label: '● On track' },
  watch: { className: 'health-watch', label: '● Watch' },
  risk: { className: 'health-watch', label: '● At risk' },
  none: { className: '', label: '' },
};

export function PortfolioPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const notify = useToast();
  const queryClient = useQueryClient();

  const portfolios = useQuery({ queryKey: ['portfolios'], queryFn: portfolioApi.list });
  const portfolioId = portfolios.data?.portfolios[0]?.id;

  const overview = useQuery({
    queryKey: ['overview', portfolioId],
    queryFn: () => portfolioApi.overview(portfolioId!),
    enabled: Boolean(portfolioId),
  });

  const [programFilter, setProgramFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [openModal, setOpenModal] = useState<null | 'project' | 'program' | 'portfolio'>(null);

  const groups = overview.data?.groups ?? [];
  const summary = overview.data?.summary;

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (project: ProjectCard) =>
      (statusFilter === 'all' || project.status.toLowerCase() === statusFilter) &&
      (typeFilter === 'all' || project.type === typeFilter) &&
      (!query || project.name.toLowerCase().includes(query));

    return groups
      .filter((group) => programFilter === 'all' || group.key === programFilter)
      .map((group) => ({ ...group, projects: group.projects.filter(matches) }))
      .filter((group) => group.projects.length > 0 || programFilter === group.key);
  }, [groups, programFilter, statusFilter, typeFilter, search]);

  const createProject = useMutation({
    mutationFn: (body: { name: string; type: ProjectType; programId: string | null; customer: string; targetStart: string }) =>
      portfolioApi.createProject(portfolioId!, body),
    onSuccess: (workspace) => {
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      notify({
        title: 'Project workspace created',
        detail: `${workspace.type} rules and planning templates are ready for PM input.`,
      });
      setOpenModal(null);
      navigate(`/projects/${workspace.id}`);
    },
  });

  const createProgram = useMutation({
    mutationFn: (body: { name: string; description?: string; targetOutcome?: string }) =>
      portfolioApi.createProgram(portfolioId!, body),
    onSuccess: (program) => {
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      notify({ title: 'Program created', detail: `${program.name} is ready to group related project workspaces.` });
      setOpenModal(null);
    },
  });

  const createPortfolio = useMutation({
    mutationFn: (body: { name: string; businessUnit?: string; strategicObjective?: string }) =>
      portfolioApi.createPortfolio(body),
    onSuccess: (portfolio) => {
      queryClient.invalidateQueries({ queryKey: ['portfolios'] });
      notify({ title: 'Portfolio created', detail: `${portfolio.name} is available as a top-level container.` });
      setOpenModal(null);
    },
  });

  if (portfolios.isLoading || overview.isLoading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Loading portfolio overview…
      </div>
    );
  }

  if (!portfolioId || !summary) {
    return (
      <>
        <div className="state-block">
          <strong>No portfolio yet</strong>
          You're not a member of any project yet, and no portfolio is set up for you. Create one to start grouping
          programs and project workspaces — you'll automatically own it.
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="primary" onClick={() => setOpenModal('portfolio')}>
              + Create portfolio
            </button>
            <button className="secondary" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
        <Backdrop open={openModal === 'portfolio'} onClose={() => setOpenModal(null)} />
        <CreatePortfolioModal
          open={openModal === 'portfolio'}
          busy={createPortfolio.isPending}
          onClose={() => setOpenModal(null)}
          onSubmit={(body) => createPortfolio.mutate(body)}
        />
      </>
    );
  }

  return (
    <>
      <section className="portfolio-screen">
        <header className="portfolio-top">
          <div className="brand portfolio-brand">
            <div className="brand-mark">N</div>
            <div>
              <strong>NextPM</strong>
              <span>Adaptive</span>
            </div>
          </div>
          <div className="portfolio-level">
            <span>PORTFOLIO CENTER</span>
            <b>Programs &amp; Projects</b>
          </div>
          <div className="portfolio-profile">
            <button className="icon-button" onClick={logout} title="Sign out">
              ◔
            </button>
            <div className="avatar">{user?.initials}</div>
            <div>
              <strong>{user?.name}</strong>
              <span>{user?.jobTitle}</span>
            </div>
          </div>
        </header>

        <div className="portfolio-layout">
          <aside className="portfolio-sidebar">
            <small>PORTFOLIO</small>
            <select className="portfolio-select" aria-label="Current portfolio">
              {portfolios.data?.portfolios.map((portfolio) => (
                <option key={portfolio.id}>{portfolio.name}</option>
              ))}
            </select>
            <button
              className={`portfolio-nav${programFilter === 'all' ? ' active' : ''}`}
              onClick={() => setProgramFilter('all')}
            >
              <span>▦</span>
              <div>
                <b>Overview</b>
                <em>
                  {summary.programs} programs · {summary.statusCounts.all} projects
                </em>
              </div>
            </button>

            <small>PROGRAMS</small>
            {groups
              .filter((group) => group.key !== 'standalone')
              .map((group) => (
                <button
                  key={group.key}
                  className={`portfolio-nav${programFilter === group.key ? ' active' : ''}`}
                  onClick={() => setProgramFilter(group.key)}
                >
                  <i className={`program-dot ${group.colorKey}-dot`} />
                  <div>
                    <b>{group.name}</b>
                    <em>{group.projects.length} projects</em>
                  </div>
                  <strong>{group.readiness === null ? '—' : `${group.readiness}%`}</strong>
                </button>
              ))}

            <small>NO PROGRAM</small>
            <button
              className={`portfolio-nav${programFilter === 'standalone' ? ' active' : ''}`}
              onClick={() => setProgramFilter('standalone')}
            >
              <span>◇</span>
              <div>
                <b>Standalone projects</b>
                <em>{groups.find((group) => group.key === 'standalone')?.projects.length ?? 0} projects</em>
              </div>
            </button>
            <button className="create-program" onClick={() => setOpenModal('program')}>
              ＋ Create program
            </button>
          </aside>

          <main className="portfolio-main">
            <div className="portfolio-breadcrumb">
              <span>Portfolio</span>
              <b>›</b>
              <strong>
                {programFilter === 'all'
                  ? 'All programs & projects'
                  : groups.find((group) => group.key === programFilter)?.name}
              </strong>
            </div>

            <div className="portfolio-title">
              <div>
                <p>PORTFOLIO OVERVIEW</p>
                <h1>Programs and project workspaces</h1>
                <span>
                  Roll up delivery health by program, then open any project workspace for planning decisions.
                </span>
              </div>
              <div className="portfolio-create-actions">
                <button className="secondary" onClick={() => setOpenModal('portfolio')}>
                  + Portfolio
                </button>
                <button className="secondary" onClick={() => setOpenModal('program')}>
                  + Program
                </button>
                <button className="primary" onClick={() => setOpenModal('project')}>
                  + Project
                </button>
              </div>
            </div>

            <div className="hierarchy-strip">
              <div className="current">
                <span>1</span>
                <p>
                  <b>Portfolio</b>
                  <small>All programs &amp; projects</small>
                </p>
              </div>
              <i>›</i>
              <div>
                <span>2</span>
                <p>
                  <b>Program / Group</b>
                  <small>Related projects &amp; roll-up health</small>
                </p>
              </div>
              <i>›</i>
              <div>
                <span>3</span>
                <p>
                  <b>Project Workspace</b>
                  <small>Input, rules, planning outputs</small>
                </p>
              </div>
            </div>

            <div className="portfolio-summary">
              <article>
                <span>PROGRAMS</span>
                <strong>{summary.programs}</strong>
                <small>{summary.activePrograms} on track</small>
              </article>
              <article>
                <span>ACTIVE PROJECTS</span>
                <strong>{summary.activeProjects}</strong>
                <small>
                  SI {summary.byType.SI} · SM {summary.byType.SM} · Product {summary.byType.PRODUCT}
                </small>
              </article>
              <article>
                <span>NEEDS ATTENTION</span>
                <strong className="amber">{summary.needsAttention}</strong>
                <small>{summary.pendingDecisions} PM decisions pending</small>
              </article>
              <article>
                <span>PORTFOLIO READINESS</span>
                <strong>{summary.portfolioReadiness}%</strong>
                <small>Weighted active average</small>
              </article>
            </div>

            <div className="portfolio-toolbar">
              <div className="project-filters">
                {(['all', 'active', 'draft', 'hold', 'closed'] as const).map((status) => (
                  <button
                    key={status}
                    className={statusFilter === status ? 'active' : ''}
                    onClick={() => setStatusFilter(status)}
                  >
                    {status === 'all' ? 'All' : status[0].toUpperCase() + status.slice(1)}{' '}
                    <b>{summary.statusCounts[status]}</b>
                  </button>
                ))}
              </div>
              <div>
                <input
                  placeholder="Search projects…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                  <option value="all">All project types</option>
                  <option value="SI">SI</option>
                  <option value="SM">SM</option>
                  <option value="PRODUCT">Product</option>
                </select>
              </div>
            </div>

            <div className="program-list">
              {visible.map((group) => (
                <section className="program-group" key={group.key}>
                  <header>
                    <div>
                      {group.key === 'standalone' ? (
                        <span className="standalone-mark">◇</span>
                      ) : (
                        <i className={`program-dot ${group.colorKey}-dot`} />
                      )}
                      <div>
                        <small>{group.key === 'standalone' ? 'NO PROGRAM' : 'PROGRAM'}</small>
                        <h2>{group.name}</h2>
                        <p>{group.description}</p>
                      </div>
                    </div>
                    <div className="program-rollup">
                      <span>
                        <b>{group.projects.length}</b> projects
                      </span>
                      {group.readiness !== null && (
                        <span>
                          <b>{group.readiness}%</b> readiness
                        </span>
                      )}
                      {group.health !== 'none' && (
                        <span className={HEALTH_LABEL[group.health].className}>{HEALTH_LABEL[group.health].label}</span>
                      )}
                      {group.key !== 'standalone' && (
                        <button onClick={() => setProgramFilter(group.key)}>Program view →</button>
                      )}
                    </div>
                  </header>
                  <div className="program-projects">
                    {group.projects.length === 0 && (
                      <div className="program-empty">
                        No project workspace yet. Use + Project to add the first one.
                      </div>
                    )}
                    {group.projects.map((project) => (
                      <article
                        className={`project-card${project.status === 'CLOSED' || project.status === 'HOLD' ? ' muted-card' : ''}`}
                        key={project.id}
                      >
                        <div className="project-card-top">
                          <span className={`project-type ${project.type.toLowerCase()}`}>{TYPE_LABEL[project.type]}</span>
                          <span className={`project-status ${STATUS_META[project.status].className}`}>
                            {STATUS_META[project.status].label}
                          </span>
                          <button>•••</button>
                        </div>
                        <h2>{project.name}</h2>
                        <p>{project.summary}</p>
                        <div className="project-readiness">
                          <span>
                            {project.status === 'DRAFT' ? 'Input completeness' : 'Planning readiness'}{' '}
                            <b>{project.status === 'DRAFT' ? project.inputReadiness : project.readiness}%</b>
                          </span>
                          <i>
                            <em
                              style={{
                                width: `${project.status === 'DRAFT' ? project.inputReadiness : project.readiness}%`,
                              }}
                            />
                          </i>
                        </div>
                        <div className="project-meta">
                          <span>
                            <b>{project.approach ? titleCase(project.approach) : 'Not selected'}</b>{' '}
                            {project.approach ? 'approach' : ''}
                          </span>
                          <span>
                            <b>{project.openDecisions}</b> decisions
                          </span>
                          <span>
                            <b>{project.targetLabel ?? '—'}</b>
                          </span>
                        </div>
                        <div className="project-footer">
                          <div className="avatar-stack">
                            {project.members.map((member) => (
                              <i key={member.id} title={member.name}>
                                {member.initials}
                              </i>
                            ))}
                          </div>
                          <button
                            className={project.status === 'ACTIVE' ? 'primary' : 'secondary'}
                            onClick={() => navigate(`/projects/${project.id}`)}
                          >
                            {project.status === 'DRAFT'
                              ? 'Continue setup →'
                              : project.status === 'CLOSED'
                                ? 'View archive →'
                                : 'Open workspace →'}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </main>
        </div>
      </section>

      <Backdrop open={openModal !== null} onClose={() => setOpenModal(null)} />

      <CreateProjectModal
        open={openModal === 'project'}
        programs={groups.filter((group) => group.key !== 'standalone').map((group) => ({ id: group.id!, name: group.name }))}
        busy={createProject.isPending}
        onClose={() => setOpenModal(null)}
        onSubmit={(body) => createProject.mutate(body)}
      />
      <CreateProgramModal
        open={openModal === 'program'}
        busy={createProgram.isPending}
        onClose={() => setOpenModal(null)}
        onSubmit={(body) => createProgram.mutate(body)}
      />
      <CreatePortfolioModal
        open={openModal === 'portfolio'}
        busy={createPortfolio.isPending}
        onClose={() => setOpenModal(null)}
        onSubmit={(body) => createPortfolio.mutate(body)}
      />
    </>
  );
}

const titleCase = (value: string) => value[0] + value.slice(1).toLowerCase();

function CreateProjectModal({
  open,
  programs,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  programs: { id: string; name: string }[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; type: ProjectType; programId: string | null; customer: string; targetStart: string }) => void;
}) {
  const [name, setName] = useState('New Korea Delivery Project');
  const [type, setType] = useState<ProjectType>('SI');
  const [programId, setProgramId] = useState<string>('');
  const [customer, setCustomer] = useState('Korea — Enterprise');
  const [targetStart, setTargetStart] = useState('2026-10-01');

  const TYPES: { key: ProjectType; badge: string; title: string; hint: string }[] = [
    { key: 'SI', badge: 'SI', title: 'System Integration', hint: 'Build, integrate, test and hand over' },
    { key: 'SM', badge: 'SM', title: 'Service Management', hint: 'Transition, operate and meet SLA' },
    { key: 'PRODUCT', badge: 'P', title: 'Product Development', hint: 'Discover, iterate and release' },
  ];

  return (
    <ModalShell open={open} className="create-project-modal">
      <div className="modal-head">
        <div>
          <small>NEW PROJECT WORKSPACE</small>
          <h2>Create project</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), type, programId: programId || null, customer, targetStart });
        }}
      >
        <label>
          Project name *
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          Project type *
          <div className="type-selector">
            {TYPES.map((option) => (
              <button
                type="button"
                key={option.key}
                className={type === option.key ? 'selected' : ''}
                onClick={() => setType(option.key)}
              >
                <span>{option.badge}</span>
                <b>{option.title}</b>
                <small>{option.hint}</small>
              </button>
            ))}
          </div>
        </label>
        <div className="create-grid">
          <label>
            Program / project group
            <select value={programId} onChange={(event) => setProgramId(event.target.value)}>
              {programs.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name}
                </option>
              ))}
              <option value="">No program — standalone</option>
            </select>
          </label>
          <label>
            Customer / market
            <input value={customer} onChange={(event) => setCustomer(event.target.value)} />
          </label>
          <label>
            Target start
            <input type="date" value={targetStart} onChange={(event) => setTargetStart(event.target.value)} />
          </label>
        </div>
        <div className="create-note">
          <span>✦</span>
          <p>
            Project type initializes the relevant input fields, dashboard widgets and document catalog. You
            can tailor them inside the workspace.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create & open workspace'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function CreateProgramModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; description?: string; targetOutcome?: string }) => void;
}) {
  const [name, setName] = useState('New Korea Transformation Program');
  const [targetOutcome, setTargetOutcome] = useState('Shared business outcome across projects');

  return (
    <ModalShell open={open} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>NEW PROGRAM</small>
          <h2>Create a project group</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), targetOutcome });
        }}
      >
        <label>
          Program name *
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <div className="create-grid">
          <label>
            Target outcome
            <input value={targetOutcome} onChange={(event) => setTargetOutcome(event.target.value)} />
          </label>
        </div>
        <div className="create-note">
          <span>▥</span>
          <p>
            A Program groups related projects and rolls up readiness, decisions and planning progress. Each project keeps
            its own workspace and approval trail.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create program'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function CreatePortfolioModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; businessUnit?: string; strategicObjective?: string }) => void;
}) {
  const [name, setName] = useState('New Strategic Portfolio');
  const [businessUnit, setBusinessUnit] = useState('FPT Software Korea');
  const [objective, setObjective] = useState('Prioritize and govern related investments');

  return (
    <ModalShell open={open} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>NEW PORTFOLIO</small>
          <h2>Create a portfolio</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), businessUnit, strategicObjective: objective });
        }}
      >
        <label>
          Portfolio name *
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <div className="create-grid">
          <label>
            Business unit
            <input value={businessUnit} onChange={(event) => setBusinessUnit(event.target.value)} />
          </label>
          <label>
            Strategic objective
            <input value={objective} onChange={(event) => setObjective(event.target.value)} />
          </label>
        </div>
        <div className="create-note">
          <span>▦</span>
          <p>A Portfolio is the top-level container for Programs and standalone Projects, with navigation and status roll-up.</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create portfolio'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
