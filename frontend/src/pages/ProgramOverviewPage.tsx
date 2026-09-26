import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { planChangeApi, programApi, projectApi } from '../api/endpoints';
import type { ProgramGroup, ProjectCard, ProjectStatus, ProjectType } from '../api/types';
import { useAuth } from '../store/auth';
import { useToast } from '../components/Toast';
import { Backdrop, ModalShell } from '../components/Modal';
import { AccountShell } from '../components/AccountShell';
import { ApiError } from '../api/client';

// "On Hold" everywhere — the filter once said "Hold", the badge "On hold" and the status dropdown
// "On hold", so one state had three spellings on one screen.
const STATUS_META: Record<string, { label: string }> = {
  ACTIVE: { label: 'Active' },
  DRAFT: { label: 'Draft' },
  HOLD: { label: 'On Hold' },
  CLOSED: { label: 'Closed' },
};

const TYPE_LABEL: Record<ProjectType, string> = { SI: 'SI', SM: 'SM', PRODUCT: 'Product' };
const HEALTH_LABEL: Record<string, { label: string }> = {
  good: { label: 'On track' },
  watch: { label: 'Watch' },
  risk: { label: 'At risk' },
  none: { label: '' },
};

/** The Approach filter's value for projects with no confirmed model yet. */
const NO_APPROACH = '__none';

/** The distinct customers of a program's projects, as its Customer cell. */
const customersOf = (group: ProgramGroup) =>
  [...new Set(group.projects.map((project) => project.customer?.trim()).filter(Boolean))].join(', ');

/** Readiness as a bar coloured by threshold: under 40 red, under 60 amber, otherwise green. */
function ReadinessBar({ value }: { value: number }) {
  const tone = value < 40 ? 'low' : value < 60 ? 'mid' : 'high';
  return (
    <div className="pc-readiness">
      <i>
        <em className={tone} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </i>
      <span>{value}%</span>
    </div>
  );
}

/** The search term marked where it occurs, so a match on the customer is visible as one. */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/**
 * The delivery landing screen — Program Center · Program Overview. Every signed-in delivery account
 * sees the same board; access is enforced per row through `canOpen`, which the API computes from
 * ownership/membership. Programs are rows with their projects nested under them, standalone
 * projects follow, and one filter bar narrows the lot.
 */
export function ProgramOverviewPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const notify = useToast();
  const queryClient = useQueryClient();

  const overview = useQuery({ queryKey: ['overview'], queryFn: programApi.overview });

  const [programFilter, setProgramFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [approachFilter, setApproachFilter] = useState('');
  const [search, setSearch] = useState('');
  /** Programs the PM folded away. Ignored while filtering, so a match is never hidden in one. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
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

  const query = search.trim().toLowerCase();
  const filtering = Boolean(query || programFilter || typeFilter || approachFilter);
  const allProjects = useMemo(() => groups.flatMap((group) => group.projects), [groups]);

  /**
   * Search reads the project, its program and its customer. A program whose own name or customers
   * match keeps all its projects — searching "Telecom" should show the Telecom program, not an
   * empty row. Standalone projects live in the `standalone` group and are filtered like any other.
   */
  const visible = useMemo(() => {
    const matchesFilters = (project: ProjectCard) =>
      (!typeFilter || project.type === typeFilter) &&
      (!approachFilter || (project.approach ?? NO_APPROACH) === approachFilter);
    return groups
      .filter((group) => !programFilter || group.key === programFilter)
      .map((group) => {
        const programHit =
          Boolean(query) && group.key !== 'standalone' && `${group.name} ${customersOf(group)}`.toLowerCase().includes(query);
        const projects = group.projects.filter(
          (project) =>
            matchesFilters(project) &&
            (!query || programHit || `${project.name} ${project.customer ?? ''}`.toLowerCase().includes(query)),
        );
        return { ...group, projects };
      })
      .filter((group) => group.projects.length > 0 || (!filtering && group.key !== 'standalone'));
  }, [groups, programFilter, typeFilter, approachFilter, query, filtering]);

  const shown = visible.reduce((sum, group) => sum + group.projects.length, 0);
  const approachOptions = useMemo(
    () => [...new Set(allProjects.map((project) => project.approach ?? NO_APPROACH))].sort(),
    [allProjects],
  );
  const clearFilters = () => {
    setSearch('');
    setProgramFilter('');
    setTypeFilter('');
    setApproachFilter('');
  };

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

  /**
   * "Update plan" from a project row.
   *
   * Opens the change first, then goes to Update Planning (step 4), where a change is recorded.
   * `startPlanChange` hands back the change already open if there is one, so pressing this twice is
   * harmless.
   */
  const startChange = useMutation({
    mutationFn: (projectId: string) => planChangeApi.start(projectId),
    onSuccess: (_change, projectId) => navigate(`/projects/${projectId}?view=update`),
    onError: fail('Could not start a plan change'),
  });

  const updateProgram = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { name?: string; description?: string | null; targetOutcome?: string | null } }) =>
      programApi.update(id, body),
    onSuccess: (program) => {
      refreshOverview();
      notify({ title: 'Program updated', detail: program.name });
      setEditProgram(null);
      // The program filter is keyed by slug, and renaming a program changes its slug.
      setProgramFilter('');
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
      setProgramFilter('');
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
      <AccountShell crumb="PROGRAM CENTER" title="Program Overview">
        <div className="page-head dash-head">
          <div>
            <h1 className="dash-title">
              <span>Program Center</span>
              <em>·</em>
              <b>Program Overview</b>
            </h1>
            <p className="page-subline">
              {capabilities.canOpenAll
                ? 'Programs and standalone projects with their current planning readiness'
                : 'Programs and standalone projects with their current planning readiness — you can open the workspaces you own or were granted'}
            </p>
          </div>
          <div className="dashboard-actions">
            {capabilities.canCreateProgram && (
              <button className="secondary" onClick={() => setOpenModal('program')}>
                + Create program
              </button>
            )}
            <button className="primary" onClick={() => setOpenModal('project')}>
              + Add project
            </button>
          </div>
        </div>

        <div className="kpi-strip">
          <article className="panel kpi">
            <span className="kpi-label">Programs</span>
            <span className="kpi-value">{summary.programs}</span>
          </article>
          <article className="panel kpi">
            <span className="kpi-label">Projects</span>
            <span className="kpi-value">{allProjects.length}</span>
          </article>
          <article className="panel kpi">
            <span className="kpi-label">Average planning readiness</span>
            <span className="kpi-value">{summary.deliveryReadiness}%</span>
          </article>
          <article className="panel kpi">
            <span className="kpi-label">Projects with open gaps</span>
            <span className="kpi-value">{allProjects.filter((project) => project.openGaps > 0).length}</span>
          </article>
        </div>

        <article className="panel program-table-panel">
          <div className="panel-head">
            <div>
              <h2>Programs &amp; projects</h2>
            </div>
          </div>

          <div className="pc-filter" role="search" aria-label="Filter projects">
            <label className="pc-field pc-search">
              <span>Search</span>
              <input
                type="search"
                placeholder="Project, program or customer"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="pc-field">
              <span>Program</span>
              <select value={programFilter} onChange={(event) => setProgramFilter(event.target.value)}>
                <option value="">All programs</option>
                {groups
                  .filter((group) => group.key !== 'standalone')
                  .map((group) => (
                    <option key={group.key} value={group.key}>
                      {group.name}
                    </option>
                  ))}
                <option value="standalone">Standalone projects</option>
              </select>
            </label>
            <label className="pc-field">
              <span>Project type</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value="">All types</option>
                <option value="SI">SI</option>
                <option value="SM">SM</option>
                <option value="PRODUCT">Product</option>
              </select>
            </label>
            <label className="pc-field">
              <span>Approach</span>
              <select value={approachFilter} onChange={(event) => setApproachFilter(event.target.value)}>
                <option value="">All approaches</option>
                {approachOptions.map((option) => (
                  <option key={option} value={option}>
                    {option === NO_APPROACH ? 'Not selected' : titleCase(option)}
                  </option>
                ))}
              </select>
            </label>
            <div className="pc-meta">
              <span aria-live="polite">{filtering ? `${shown} of ${allProjects.length} projects` : `${allProjects.length} projects`}</span>
              {filtering && (
                <button className="link-button" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          </div>

          <div className="pc-table-wrap">
            <table className="pc-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Customer</th>
                  <th>Approach</th>
                  <th>Planning readiness</th>
                  <th>Status</th>
                  <th>Open gaps</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown === 0 && filtering && (
                  <tr>
                    <td className="pc-empty" colSpan={8}>
                      <b>No projects match these filters</b>
                      Change the search or filters, or{' '}
                      <button className="link-button" onClick={clearFilters}>
                        clear all filters
                      </button>
                      .
                    </td>
                  </tr>
                )}
                {visible.map((group) => {
                  const isProgram = group.key !== 'standalone';
                  const open = filtering || !collapsed[group.key];
                  const approaches = [...new Set(group.projects.map((project) => project.approach).filter(Boolean))];
                  return (
                    <Fragment key={group.key}>
                      {isProgram && (
                        <tr className="pc-program">
                          <td>
                            <button
                              className="pc-toggle"
                              aria-expanded={open}
                              disabled={filtering}
                              title={filtering ? 'Expanded while filtering' : open ? 'Collapse' : 'Expand'}
                              onClick={() => setCollapsed((state) => ({ ...state, [group.key]: !state[group.key] }))}
                            >
                              {open ? '▾' : '▸'}
                            </button>
                            <Highlight text={group.name} query={query} />
                          </td>
                          <td>Program</td>
                          <td>
                            <Highlight text={customersOf(group) || '—'} query={query} />
                          </td>
                          <td>{approaches.length > 1 ? 'Mixed' : approaches[0] ? titleCase(approaches[0]) : '—'}</td>
                          <td>{group.readiness === null ? '—' : <ReadinessBar value={group.readiness} />}</td>
                          <td>
                            {group.health !== 'none' && (
                              <span className={`pc-chip health-${group.health}`}>{HEALTH_LABEL[group.health].label}</span>
                            )}
                          </td>
                          <td className="num">{group.projects.reduce((sum, project) => sum + project.openGaps, 0)}</td>
                          <td>
                            <div className="pc-actions">
                              {capabilities.canCreateProgram && (
                                <button className="pc-btn" onClick={() => setEditProgram(group)}>
                                  Edit
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                      {isProgram && open && group.projects.length === 0 && (
                        <tr className="pc-project">
                          <td colSpan={8} className="pc-none">
                            No project workspace yet. Use + Add project to add the first one.
                          </td>
                        </tr>
                      )}
                      {open &&
                        group.projects.map((project) => (
                          <tr
                            key={project.id}
                            className={`${isProgram ? 'pc-project' : ''}${!project.canOpen ? ' pc-locked' : ''}`}
                          >
                            <td>
                              {isProgram && <span className="pc-branch">↳ </span>}
                              <Highlight text={project.name} query={query} />
                              {!isProgram && <span className="pc-chip standalone">Standalone</span>}
                            </td>
                            <td>{TYPE_LABEL[project.type]}</td>
                            <td>
                              <Highlight text={project.customer || '—'} query={query} />
                            </td>
                            <td>{project.approach ? titleCase(project.approach) : 'Not selected'}</td>
                            <td>
                              <ReadinessBar value={project.readiness} />
                            </td>
                            <td>
                              <span className={`pc-chip status-${project.status.toLowerCase()}`}>
                                {STATUS_META[project.status].label}
                              </span>
                            </td>
                            <td className="num">{project.openGaps}</td>
                            <td>
                              <div className="pc-actions">
                                {project.canEdit && (
                                  <button className="pc-btn blue" onClick={() => setEditProject(project)}>
                                    Edit
                                  </button>
                                )}
                                {project.canChangePlan && (
                                  <button
                                    className="pc-btn blue"
                                    disabled={startChange.isPending}
                                    title="Record something that has changed since this plan was confirmed"
                                    onClick={() => startChange.mutate(project.id)}
                                  >
                                    {startChange.isPending && startChange.variables === project.id ? 'Opening…' : 'Update plan'}
                                  </button>
                                )}
                                {project.canOpen ? (
                                  <button className="pc-btn blue" onClick={() => navigate(`/projects/${project.id}`)}>
                                    Open workspace
                                  </button>
                                ) : (
                                  <button className="pc-btn" disabled title="Ask the project owner to add you to this project">
                                    🔒 No access
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </article>
      </AccountShell>

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
              <option value="HOLD">On Hold</option>
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

const titleCase = (value: string) =>
  value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .join(' ');

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
