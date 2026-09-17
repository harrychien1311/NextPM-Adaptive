import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { programApi, projectApi } from '../api/endpoints';
import type { ProgramGroup, ProjectCard, ProjectStatus, ProjectType } from '../api/types';
import { useAuth } from '../store/auth';
import { useToast } from '../components/Toast';
import { Backdrop, ModalShell } from '../components/Modal';
import { SignOutIcon } from '../components/icons';
import { ApiError } from '../api/client';

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

/**
 * The delivery landing screen. Every signed-in delivery account sees the same board; access is
 * enforced per project card through `canOpen`, which the API computes from ownership/membership.
 */
export function ProgramOverviewPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const notify = useToast();
  const queryClient = useQueryClient();

  const overview = useQuery({ queryKey: ['overview'], queryFn: programApi.overview });

  const [programFilter, setProgramFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [openModal, setOpenModal] = useState<null | 'project' | 'program'>(null);
  const [editProgram, setEditProgram] = useState<ProgramGroup | null>(null);
  const [editProject, setEditProject] = useState<ProjectCard | null>(null);

  const groups = overview.data?.groups ?? [];
  const summary = overview.data?.summary;
  const capabilities = overview.data?.capabilities;

  // A brand-new account owns nothing yet — open the create-project dialog straight away so the
  // first screen it ever sees is actionable rather than an empty board.
  const promptedRef = useRef(false);
  useEffect(() => {
    if (!summary || promptedRef.current) return;
    promptedRef.current = true;
    if (summary.myProjects === 0) setOpenModal('project');
  }, [summary]);

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
      projectApi.create(body),
    onSuccess: (workspace) => {
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      notify({
        title: 'Project workspace created',
        detail: `${workspace.type} input profile and planning templates are ready — you own this project.`,
      });
      setOpenModal(null);
      // Straight to Project Input: a project one second old has nothing to show on a dashboard,
      // and the first thing its owner must do is upload the document the analysis reads.
      navigate(`/projects/${workspace.id}?view=input`);
    },
    onError: (error) =>
      notify({ title: 'Could not create project', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const createProgram = useMutation({
    mutationFn: (body: { name: string; description?: string; targetOutcome?: string }) => programApi.create(body),
    onSuccess: (program) => {
      queryClient.invalidateQueries({ queryKey: ['overview'] });
      notify({ title: 'Program created', detail: `${program.name} is ready to group related project workspaces.` });
      setOpenModal(null);
    },
    onError: (error) =>
      notify({ title: 'Could not create program', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const fail = (title: string) => (error: unknown) =>
    notify({ title, detail: error instanceof ApiError ? error.message : 'Unexpected error' });
  const refreshOverview = () => queryClient.invalidateQueries({ queryKey: ['overview'] });

  const updateProgram = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; description?: string | null; targetOutcome?: string | null } }) =>
      programApi.update(id, body),
    onSuccess: (program) => {
      refreshOverview();
      notify({ title: 'Program updated', detail: program.name });
      setEditProgram(null);
      // The sidebar filter is keyed by slug, and renaming a program changes its slug.
      setProgramFilter('all');
    },
    onError: fail('Could not update program'),
  });

  const removeProgram = useMutation({
    mutationFn: (id: string) => programApi.remove(id),
    onSuccess: (result) => {
      refreshOverview();
      notify({
        title: `${result.name} deleted`,
        detail: result.projectsReleased
          ? `${result.projectsReleased} project${result.projectsReleased === 1 ? '' : 's'} kept and moved to Standalone.`
          : 'It had no projects.',
      });
      setEditProgram(null);
      setProgramFilter('all');
    },
    onError: fail('Could not delete program'),
  });

  const updateProject = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof projectApi.update>[1] }) =>
      projectApi.update(id, body),
    onSuccess: (workspace) => {
      refreshOverview();
      queryClient.invalidateQueries({ queryKey: ['workspace', workspace.id] });
      notify({ title: 'Project updated', detail: workspace.name });
      setEditProject(null);
    },
    onError: fail('Could not update project'),
  });

  const removeProject = useMutation({
    mutationFn: (id: string) => projectApi.remove(id),
    onSuccess: (result) => {
      refreshOverview();
      notify({
        title: `${result.name} deleted`,
        detail: `The workspace and its ${result.documentsRemoved} document(s) are gone for good.`,
      });
      setEditProject(null);
    },
    onError: fail('Could not delete project'),
  });

  if (overview.isLoading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Loading program overview…
      </div>
    );
  }

  if (overview.isError || !summary || !capabilities) {
    return (
      <div className="state-block">
        <strong>Overview unavailable</strong>
        {overview.error instanceof ApiError ? overview.error.message : 'The program overview could not be loaded.'}
        <div style={{ marginTop: 16 }}>
          <button className="secondary" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="portfolio-screen">
        <header className="portfolio-top">
          <div className="brand portfolio-brand">
            <div className="brand-mark">N</div>
            <div>
              <strong>NEXTFIT AI</strong>
              <span>Adaptive</span>
            </div>
          </div>
          <div className="portfolio-level">
            <span>PROGRAM CENTER</span>
            <b>Programs &amp; Projects</b>
          </div>
          <div className="portfolio-profile">
            <div className="avatar">{user?.initials}</div>
            <div>
              <strong>{user?.name}</strong>
              <span>{ROLE_LABEL[user?.role ?? 'PROJECT_OWNER']}</span>
            </div>
            {/* Last child, so sign out is the top-right corner — the same place on every screen. */}
            <button className="icon-button signout-button" onClick={logout} title="Sign out" aria-label="Sign out">
              <SignOutIcon />
            </button>
          </div>
        </header>

        <div className="portfolio-layout">
          <aside className="portfolio-sidebar">
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
            {capabilities.canCreateProgram && (
              <button className="create-program" onClick={() => setOpenModal('program')}>
                ＋ Create program
              </button>
            )}
          </aside>

          <main className="portfolio-main">
            <div className="portfolio-breadcrumb">
              <span>Programs</span>
              <b>›</b>
              <strong>
                {programFilter === 'all'
                  ? 'All programs & projects'
                  : groups.find((group) => group.key === programFilter)?.name}
              </strong>
            </div>

            <div className="portfolio-title">
              <div>
                <p>PROGRAM OVERVIEW</p>
                <h1>Programs and project workspaces</h1>
                <span>
                  {capabilities.canOpenAll
                    ? 'Roll up delivery health by program, then open any project workspace for planning decisions.'
                    : 'You can open the project workspaces you own or were granted — the rest stay read-only here.'}
                </span>
              </div>
              <div className="portfolio-create-actions">
                {/* The per-customer checklists and templates every project here is measured against. */}
                <Link className="secondary button-link" to="/customers">
                  Customer library
                </Link>
                {capabilities.canCreateProgram && (
                  <button className="secondary" onClick={() => setOpenModal('program')}>
                    + Program
                  </button>
                )}
                <button className="primary" onClick={() => setOpenModal('project')}>
                  + Project
                </button>
              </div>
            </div>

            <div className="hierarchy-strip">
              <div className="current">
                <span>1</span>
                <p>
                  <b>Program / Group</b>
                  <small>Related projects &amp; roll-up health</small>
                </p>
              </div>
              <i>›</i>
              <div>
                <span>2</span>
                <p>
                  <b>Project Workspace</b>
                  <small>Input, governance model, planning outputs</small>
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
                <span>MY WORKSPACES</span>
                <strong>{summary.myProjects}</strong>
                <small>{summary.needsAttention} need attention</small>
              </article>
              <article>
                <span>DELIVERY READINESS</span>
                <strong>{summary.deliveryReadiness}%</strong>
                <small>Active project average</small>
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
                      {group.key !== 'standalone' && capabilities.canCreateProgram && (
                        <button onClick={() => setEditProgram(group)}>Edit</button>
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
                        className={`project-card${project.status === 'CLOSED' || project.status === 'HOLD' || !project.canOpen ? ' muted-card' : ''}`}
                        key={project.id}
                      >
                        <div className="project-card-top">
                          <span className={`project-type ${project.type.toLowerCase()}`}>{TYPE_LABEL[project.type]}</span>
                          <span className={`project-status ${STATUS_META[project.status].className}`}>
                            {STATUS_META[project.status].label}
                          </span>
                          {!project.canOpen && <span className="locked-chip" title="You have not been granted this project">🔒</span>}
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
                          <div className="card-actions">
                            {project.canEdit && (
                              <button className="secondary" onClick={() => setEditProject(project)} title="Rename, re-file or change status">
                                Edit
                              </button>
                            )}
                            {project.canOpen ? (
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
                            ) : (
                              <button className="secondary" disabled title="Ask the project owner to add you to this project">
                                🔒 No access
                              </button>
                            )}
                          </div>
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

      <Backdrop
        open={openModal !== null || editProgram !== null || editProject !== null}
        onClose={() => {
          setOpenModal(null);
          setEditProgram(null);
          setEditProject(null);
        }}
      />

      <CreateProjectModal
        open={openModal === 'project'}
        firstRun={summary.myProjects === 0}
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
      <EditProgramModal
        program={editProgram}
        busy={updateProgram.isPending || removeProgram.isPending}
        onClose={() => setEditProgram(null)}
        onSubmit={(body) => editProgram?.id && updateProgram.mutate({ id: editProgram.id, body })}
        onDelete={() => editProgram?.id && removeProgram.mutate(editProgram.id)}
      />
      <EditProjectModal
        project={editProject}
        programs={groups.filter((group) => group.key !== 'standalone').map((group) => ({ id: group.id!, name: group.name }))}
        busy={updateProject.isPending || removeProject.isPending}
        onClose={() => setEditProject(null)}
        onSubmit={(body) => editProject && updateProject.mutate({ id: editProject.id, body })}
        onDelete={() => editProject && removeProject.mutate(editProject.id)}
      />
    </>
  );
}

function EditProgramModal({
  program,
  busy,
  onClose,
  onSubmit,
  onDelete,
}: {
  program: ProgramGroup | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; description?: string | null; targetOutcome?: string | null }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targetOutcome, setTargetOutcome] = useState('');

  // Reload the fields whenever a different program is opened.
  useEffect(() => {
    setName(program?.name ?? '');
    setDescription(program?.description ?? '');
    setTargetOutcome(program?.targetOutcome ?? '');
  }, [program]);

  const projectCount = program?.projects.length ?? 0;

  return (
    <ModalShell open={program !== null} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>EDIT PROGRAM</small>
          <h2>{program?.name}</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), description: description.trim() || null, targetOutcome: targetOutcome.trim() || null });
        }}
      >
        <label>
          Program name *
          <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
        </label>
        <div className="create-grid">
          <label>
            Description
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label>
            Target outcome
            <input value={targetOutcome} onChange={(event) => setTargetOutcome(event.target.value)} />
          </label>
        </div>

        <div className="danger-zone">
          <div>
            <strong>Delete this program</strong>
            <small>
              {projectCount
                ? `Its ${projectCount} project${projectCount === 1 ? '' : 's'} are NOT deleted — they move to Standalone projects.`
                : 'It has no projects.'}
            </small>
          </div>
          <button
            type="button"
            className="secondary danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete the program "${program?.name}"? Its projects will move to Standalone.`)) onDelete();
            }}
          >
            Delete program
          </button>
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function EditProjectModal({
  project,
  programs,
  busy,
  onClose,
  onSubmit,
  onDelete,
}: {
  project: ProjectCard | null;
  programs: { id: string; name: string }[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: {
    name: string;
    status: ProjectStatus;
    summary?: string;
    customer?: string;
    targetLabel?: string;
    programId: string | null;
  }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('DRAFT');
  const [summary, setSummary] = useState('');
  const [customer, setCustomer] = useState('');
  const [targetLabel, setTargetLabel] = useState('');
  const [programId, setProgramId] = useState('');

  useEffect(() => {
    setName(project?.name ?? '');
    setStatus(project?.status ?? 'DRAFT');
    setSummary(project?.summary ?? '');
    setCustomer(project?.customer ?? '');
    setTargetLabel(project?.targetLabel ?? '');
    setProgramId(project?.programId ?? '');
  }, [project]);

  return (
    <ModalShell open={project !== null} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>EDIT PROJECT</small>
          <h2>{project?.name}</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name: name.trim(),
            status,
            summary: summary.trim() || undefined,
            customer: customer.trim() || undefined,
            targetLabel: targetLabel.trim() || undefined,
            programId: programId || null,
          });
        }}
      >
        <label>
          Project name *
          <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
        </label>
        <div className="create-grid">
          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value as ProjectStatus)}>
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
              <option value="HOLD">On hold</option>
              <option value="CLOSED">Closed</option>
            </select>
          </label>
          <label>
            Program / project group
            <select value={programId} onChange={(event) => setProgramId(event.target.value)}>
              <option value="">No program — standalone</option>
              {programs.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Customer / market
            <input value={customer} onChange={(event) => setCustomer(event.target.value)} />
          </label>
          <label>
            Target label
            <input
              value={targetLabel}
              onChange={(event) => setTargetLabel(event.target.value)}
              placeholder="Mar 31 target"
            />
          </label>
        </div>
        <label>
          Summary
          <input value={summary} onChange={(event) => setSummary(event.target.value)} />
        </label>

        {project?.canDelete && (
          <div className="danger-zone">
            <div>
              <strong>Delete this project</strong>
              <small>
                Removes the workspace and everything in it — inputs, uploads, recommendations, decisions, generated
                documents and the audit trail. This cannot be undone.
              </small>
            </div>
            <button
              type="button"
              className="secondary danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Permanently delete "${project?.name}" and all of its planning data?`)) onDelete();
              }}
            >
              Delete project
            </button>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: 'Administrator',
  PROGRAM_OWNER: 'Program owner',
  PROJECT_OWNER: 'Project owner',
};

const titleCase = (value: string) => value[0] + value.slice(1).toLowerCase();

function CreateProjectModal({
  open,
  firstRun,
  programs,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  firstRun: boolean;
  programs: { id: string; name: string }[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; type: ProjectType; programId: string | null; customer: string; targetStart: string }) => void;
}) {
  // Empty for the same reason as Customer below: a prefilled field is one nobody edits, and the
  // project's name is its identity everywhere else in the app.
  const [name, setName] = useState('');
  const [type, setType] = useState<ProjectType>('SI');
  const [programId, setProgramId] = useState<string>('');
  /**
   * Empty, with only a placeholder to suggest the shape of an answer.
   *
   * It used to arrive holding "Korea — Enterprise", and a prefilled field is one nobody edits — so
   * that string became the customer of almost every project in the database. It matches no alias,
   * which means those projects silently fall through to the house default: no customer checklist,
   * and the neutral kickoff deck instead of the customer's own template. A prefilled value here is
   * not a convenience, it is a wrong answer nobody was asked to confirm.
   */
  const [customer, setCustomer] = useState('');
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
          <small>{firstRun ? 'START HERE' : 'NEW PROJECT WORKSPACE'}</small>
          <h2>{firstRun ? 'Create your first project' : 'Create project'}</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name: name.trim(), type, programId: programId || null, customer: customer.trim(), targetStart });
        }}
      >
        <label>
          Project name *
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Swing Order Operation, KR Commerce Modernization"
            required
          />
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
            {/*
              Required, because this one field decides which customer checklist scores the project
              and whose kickoff template gets filled. Left blank it falls through to the house
              default silently, and the PM finds out much later — on the wrong deck.
            */}
            Customer *
            <input
              value={customer}
              onChange={(event) => setCustomer(event.target.value)}
              placeholder="e.g. SK AX, LG CNS, Viettel"
              required
            />
          </label>
          <label>
            Target start
            <input type="date" value={targetStart} onChange={(event) => setTargetStart(event.target.value)} />
          </label>
        </div>
        <div className="create-note">
          <span>✦</span>
          <p>
            You become the owner of this project — only you, and the teammates you invite, can open its workspace.
            Project type initializes the relevant input fields, dashboard widgets and document catalog.
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
