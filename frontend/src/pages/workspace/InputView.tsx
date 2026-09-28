import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inputApi, projectApi, rulesApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { useProjectWrite } from '../../hooks/useProjectWrite';
import { CustomerConfirmBanner } from './CustomerConfirmBanner';
import { describeCustomerStandard, type InputField } from '../../api/types';
import { categoryLabel, PROJECT_CATEGORIES } from '../../api/project-categories';
import type { WorkspaceView } from '../WorkspacePage';

/** One wording for every disabled control, so a reader is told why rather than left guessing. */
const READ_ONLY_HINT = 'You have view-only access to this project';

/**
 * The models the PM can declare up front. Mirrors `DEFAULT_GOVERNANCE_MODELS` on the server — the
 * analysis accepts any string, but a dropdown is the point here: a PM who has already decided
 * should pick, not type.
 */
const GOVERNANCE_MODELS: { value: string; label: string }[] = [
  { value: 'WATERFALL', label: 'Waterfall' },
  { value: 'SCRUM', label: 'Scrum' },
  { value: 'KANBAN', label: 'Kanban' },
  { value: 'HYBRID', label: 'Hybrid' },
  { value: 'ITERATIVE', label: 'Iterative' },
  { value: 'STAGE_GATE', label: 'Predictive / Stage-Gate' },
  // Last, and labelled with the condition: SAFe is only the right answer for multi-team work, and a
  // PM picking from a list has no other way to know that before they have picked it.
  { value: 'SAFE', label: 'SAFe / Scaled Agile (multi-team only)' },
];

/** Every format `lib/extract-text.ts` is asked to read, in one place so both upload boxes agree. */
const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt';

/** Mirrors the server's own limits for change uploads, so the box states them before it refuses. */
const MAX_CHANGE_DOCUMENTS = 10;
const MAX_CHANGE_UPLOAD_MB = 10;

/** What this screen genuinely requires before *Analyze planning needs* can do anything. */
interface RequiredState {
  name: boolean;
  type: boolean;
  description: boolean;
}

const REQUIRED_INPUTS: { key: keyof RequiredState; label: string; done: (state: RequiredState) => boolean }[] = [
  { key: 'name', label: 'Project name', done: (state) => state.name },
  // Always satisfied in practice — a project cannot exist without a type — but it is one of the
  // three things asked for, and a checklist that hides a satisfied item is a checklist you stop
  // trusting when it hides an unsatisfied one.
  { key: 'type', label: 'Project type', done: (state) => state.type },
  { key: 'description', label: 'Description document', done: (state) => state.description },
];

export function InputView({
  projectId,
  onNavigate,
}: {
  projectId: string;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  /** A reader sees the same screen, with nothing on it that pretends to accept a change. */
  const canWrite = useProjectWrite(projectId);

  // The project type and the PM's chosen approach live on the project, not on the input form.
  const workspace = useQuery({
    queryKey: ['workspace', projectId],
    queryFn: () => projectApi.workspace(projectId),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['input', projectId],
    queryFn: () => inputApi.profile(projectId),
  });

  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  /**
   * Everything on this screen moves a figure on the dashboard — domain coverage, the Ready-to-Start
   * ring while its basis is INPUT, the uploaded files in the document list — and none of it used to
   * say so, which left a PM who filled the form in and went straight back to the dashboard reading
   * the numbers from before they started.
   *
   * Only one workspace view is mounted at a time, so the dashboard query is inactive while this
   * screen is open: this marks it stale and costs no request until the PM actually opens it.
   */
  const refreshDashboard = () => queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });

  // The form is three fixed items now, so there is no per-field visibility to remember.
  useEffect(() => {
    setDraft({});
  }, [projectId]);


  const save = useMutation({
    mutationFn: (values: { definitionId: string; value: string | null }[]) => inputApi.save(projectId, values),
    onSuccess: (profile) => {
      queryClient.setQueryData(['input', projectId], profile);
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      refreshDashboard();
      setSavedAt(new Date());
    },
  });

  const autoSave = useDebouncedCallback((definitionId: string, value: string | null) => {
    save.mutate([{ definitionId, value }]);
  }, 900);

  /**
   * "Analyze planning needs" — the one model call on the path from here to a document pack.
   *
   * It replaces the old pair of buttons. *Verify input* existed to read documents into the form so
   * the PM could promote each value one at a time; the analysis now reads them itself and answers
   * about the project instead — what it is, how to govern it, what is missing, what contradicts
   * itself — so there is nothing left for a second button to do.
   *
   * The server has no offline fallback for it on purpose, so a missing API key surfaces here as a
   * plain failure rather than as a plausible-looking analysis nobody actually produced.
   */
  const analyze = useMutation({
    mutationFn: () => rulesApi.analyze(projectId),
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['approach', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['studio', projectId] }),
        // The same request ran the FPT standard and the customer's checklist.
        queryClient.invalidateQueries({ queryKey: ['assessment', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['checklist', projectId] }),
        // The assessment is what opens the PM action center's entries, so the dashboard changes most
        // of all here.
        refreshDashboard(),
      ]);
      notify({
        title: result.assessment.ok ? 'Analysis and assessment ready' : 'Analysis ready — the FPT assessment failed',
        detail: [
          result.assessment.ok
            ? `FPT standard ${result.assessment.fptScore}%.`
            : `FPT standard not assessed: ${result.assessment.error ?? 'unexpected error'} Re-assess on Planning Assessment.`,
          describeCustomerStandard(result.customerStandard),
          'Opening Planning Assessment.',
        ].join(' '),
      });
      setTimeout(() => onNavigate('approach'), 350);
    },
    onError: (error) =>
      notify({
        title: 'Analysis failed',
        detail: error instanceof ApiError ? error.message : 'Unexpected error',
      }),
  });

  /**
   * The row being added. "+ Add custom field" opens it on the screen — name and value boxes, no
   * browser prompt — and it is saved as one field once it has a name.
   */
  const [newField, setNewField] = useState<{ name: string; value: string } | null>(null);
  const newFieldNameRef = useRef<HTMLInputElement>(null);

  const addField = useMutation({
    mutationFn: (field: { name: string; value: string }) =>
      inputApi.addCustomField(projectId, { name: field.name, value: field.value || undefined }),
    onSuccess: () => {
      setNewField(null);
      setSavedAt(new Date());
      return queryClient.invalidateQueries({ queryKey: ['input', projectId] });
    },
    onError: (error) =>
      notify({ title: 'Could not add the field', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const updateField = useMutation({
    mutationFn: ({ id, changes }: { id: string; changes: { name?: string; value?: string | null } }) =>
      inputApi.updateCustomField(projectId, id, changes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      setSavedAt(new Date());
    },
    onError: (error) =>
      notify({ title: 'Could not save the field', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const removeField = useMutation({
    mutationFn: (id: string) => inputApi.removeCustomField(projectId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['input', projectId] }),
  });

  const uploadReference = useMutation({
    mutationFn: ({ group, file }: { group: string; file: File }) => inputApi.uploadReference(projectId, group, file),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      refreshDashboard();
      notify({
        title: 'Reference queued for verification',
        detail: `${variables.file.name} was checked against the group rules.`,
      });
    },
    onError: (error) => notify({ title: 'Upload rejected', detail: (error as Error).message }),
  });

  const uploadDescription = useMutation({
    mutationFn: (file: File) => inputApi.uploadDescription(projectId, file),
    onSuccess: (_result, file: File) => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      // The server pairs this upload with the version it replaced when a change is open, so the
      // panel has to re-read it or the two selects would still show the state from before.
      queryClient.invalidateQueries({ queryKey: ['plan-change', projectId] });
      refreshDashboard();
      notify({
        title: 'Project description saved',
        detail: `${file.name} will be read the next time you ask the AI for a governance-model recommendation.`,
      });
    },
    onError: (error) => notify({ title: 'Upload rejected', detail: (error as Error).message }),
  });

  /**
   * Saves a project-level answer. Changing the project type can move it to another delivery family,
   * which re-reads the whole input schema and the document catalog — so the input profile is
   * invalidated alongside the workspace, and the notice says which of the two happened.
   */
  const setProjectField = useMutation({
    mutationFn: (patch: { category?: string; preferredApproach?: string | null }) =>
      projectApi.update(projectId, patch),
    onSuccess: async (result, patch) => {
      const previousFamily = workspace.data?.type;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['input', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['studio', projectId] }),
        // A new family swaps the whole document catalog, so Document progress changes with it.
        refreshDashboard(),
      ]);
      if (patch.category) {
        notify({
          title: `Project type: ${patch.category}`,
          detail:
            result.type !== previousFamily
              ? 'This type plans with a different document catalog, so the planning documents for this project changed with it.'
              : 'The AI reads the new type from the next analysis; the document catalog is the same.',
        });
      }
    },
    onError: (error) => notify({ title: 'Could not save', detail: (error as Error).message }),
  });

  const removeDescription = useMutation({
    mutationFn: (id: string) => inputApi.removeReference(projectId, id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      refreshDashboard();
      // Deleting a new version brings back the one it replaced — say so, or the slot silently
      // shows a different file than the PM expected.
      if (result.restored.length) {
        notify({
          title: `${result.restored.join(', ')} is the project description again`,
          detail: 'The file you deleted had replaced it, so the earlier version is current once more.',
        });
      }
    },
    onError: (error) => notify({ title: 'Could not remove the file', detail: (error as Error).message }),
  });

  /**
   * Once a governance model is confirmed the project has a plan, and "analyse it again" stops being
   * the right action — what the PM needs then is to record what *changed*. That is its own step now,
   * Update Planning (step 4), so this screen only points there; the change is not recorded here.
   */
  const hasPlan = Boolean(workspace.data?.approach);

  /** The same call, from the reference groups — without it a PM cannot clear a file they added. */
  const removeReferenceFile = useMutation({
    mutationFn: (id: string) => inputApi.removeReference(projectId, id),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      refreshDashboard();
      if (result.restored.length) {
        notify({
          title: `${result.restored.join(', ')} is current again`,
          detail: 'The file you deleted had replaced it, so the earlier version is read by the AI once more.',
        });
      }
    },
    onError: (error) => notify({ title: 'Could not remove the file', detail: (error as Error).message }),
  });

  if (isLoading || !data) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading the input profile…
        </div>
      </section>
    );
  }

  const valueOf = (field: InputField) => draft[field.definitionId] ?? field.value ?? '';

  const change = (field: InputField, value: string) => {
    setDraft((current) => ({ ...current, [field.definitionId]: value }));
    autoSave(field.definitionId, value || null);
  };

  /** Flushes everything typed since the last save, instead of waiting out the autosave debounce. */
  const pendingDraftValues = () =>
    Object.entries(draft).map(([definitionId, value]) => ({ definitionId, value: value || null }));

  /**
   * The minimum profile is exactly three answers, and that is the whole of it.
   *
   * It is not seventeen fields with fourteen hidden behind a toggle — that arrangement kept asking
   * the PM to wonder what they were not being shown. The analysis reads the uploaded documents, so
   * the form only has to carry what a document cannot say: the project's own name, its type, and
   * whether the PM has already decided how to govern it. Anything else a particular project needs
   * is added explicitly with *Add custom field*.
   *
   * The other definitions still exist in the database and still hold any value they were given —
   * they are simply not part of this screen any more.
   */
  const nameField = data.fields.find((field) => /^(project|service|product)Name$/.test(field.key));
  /**
   * Contract type is an ordinary input field (unlike type and approach, which live on `Project`), so
   * it saves like any other answer and reaches the analysis as a verified input. Optional: "Not
   * specified" leaves it blank rather than claiming a contract nobody named.
   */
  const contractField = data.fields.find((field) => field.key === 'contractType');
  /** A headcount, saved like contract type — as an ordinary input the analysis reads as verified. */
  const teamSizeField = data.fields.find((field) => field.key === 'teamSize');

  const requiredState: RequiredState = {
    name: Boolean(nameField && valueOf(nameField).trim()),
    type: Boolean(workspace.data?.type),
    // The upload only counts once its text could actually be read: a scanned PDF is on the screen
    // but says nothing to the analysis, and calling that "provided" would be a lie the PM only
    // discovers when the analysis comes back thin.
    description: Boolean(data.descriptionDocument?.textAvailable),
  };
  const requiredDone = REQUIRED_INPUTS.filter((item) => item.done(requiredState)).length;
  const missingRequired = REQUIRED_INPUTS.filter((item) => !item.done(requiredState));

  /**
   * Refuses in the PM's own terms instead of leaving them to work out why nothing happened.
   *
   * The check is deliberately the same `REQUIRED_INPUTS` list the meter above counts, so the two
   * can never disagree about what is missing — a button that refuses for a reason the checklist
   * does not show is worse than no checklist.
   */
  const startAnalysis = () => {
    if (missingRequired.length) {
      const names = missingRequired.map((item) => item.label);
      /*
        An uploaded file whose text could not be read is a different problem from no file at all —
        the PM can see it sitting on the screen, so "Description document is missing" would read as
        a bug in the app rather than as something they have to act on.
      */
      const unreadable = data.descriptionDocument && !data.descriptionDocument.textAvailable;
      notify({
        title: `Cannot analyse yet — ${names.length} required input${names.length === 1 ? '' : 's'} missing`,
        detail: unreadable
          ? `No text could be read from ${data.descriptionDocument!.fileName}, so the analysis has nothing to work from. Re-upload it as a PDF with a text layer, Word, Excel, PowerPoint or TXT.`
          : `Still needed: ${names.join(', ')}.` +
            (requiredState.description
              ? ''
              : ' The analysis reads the uploaded documents, so it has nothing to work from without one.'),
      });
      return;
    }
    analyze.mutate();
  };

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PLANNING FLOW 1 · INPUT &amp; VERIFY</p>
          <h1>
            {data.projectType === 'SM'
              ? 'Provide the minimum service context.'
              : data.projectType === 'PRODUCT'
                ? 'Provide the minimum product context.'
                : 'Provide the minimum delivery context.'}
          </h1>
        </div>
        {/*
          Counts the three things this screen actually asks for, not a percentage over the
          seventeen field definitions still in the database. The form stopped showing those, so a
          meter scored against them would have read 6% with everything on screen filled in — a
          number that is arithmetically correct and tells the PM nothing true.

          `computeInputReadiness` is deliberately left alone: domain readiness, project readiness
          and the program roll-up all share it, and none of them is this screen's progress bar.
        */}
        {(
          <div className="completion required-inputs">
            <span>Required inputs</span>
            <strong>
              {requiredDone}/{REQUIRED_INPUTS.length}
            </strong>
            <div>
              <i style={{ width: `${(requiredDone / REQUIRED_INPUTS.length) * 100}%` }} />
            </div>
            <ul>
              {REQUIRED_INPUTS.map((item) => (
                <li key={item.key} className={item.done(requiredState) ? 'done' : ''}>
                  {item.done(requiredState) ? '✓' : '○'} {item.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/*
        Above the form on purpose: the customer decides which checklist scores this project and
        whose template its kickoff deck fills, so it should be settled before the PM works down
        the fields — not discovered afterwards.
      */}
      <CustomerConfirmBanner projectId={projectId} suggestion={data.customerSuggestion} />

      {/*
        The uploads come before the form on purpose. Reading a document is the cheapest way to fill
        this profile in, so the PM should be offered it first — answering thirty fields by hand and
        only then finding the upload box is the wrong order.

        Documents that carry a *change* to a confirmed plan are uploaded in Update Planning, on the
        change itself, so that each lands attached to the question it answers.
      */}
      <>
      <article className="panel upload-panel description-panel">
        <div className="upload-head">
          <div>
            <span className="domain-glyph navy">D</span>
            <div>
              <h2>Project description document</h2>
              <p>A short brief, proposal or overview — read for AI analysis, not just structured extraction</p>
            </div>
          </div>
          {/* The analysis reads documents and refuses to run without one, so this is not optional. */}
          <span className="required-chip mandatory-chip">Mandatory *</span>
        </div>

        {data.descriptionDocument && (
          <div className="requirement-cards">
            <div className={`req-card${data.descriptionDocument.textAvailable ? '' : ' pending'}`}>
              <span>{data.descriptionDocument.textAvailable ? '✓' : '!'}</span>
              <div>
                <strong>{data.descriptionDocument.fileName}</strong>
                <small>{data.descriptionDocument.message}</small>
              </div>
              <button
                type="button"
                onClick={() => removeDescription.mutate(data.descriptionDocument!.id)}
                disabled={!canWrite || removeDescription.isPending}
                title={canWrite ? undefined : READ_ONLY_HINT}
              >
                Remove
              </button>
            </div>
          </div>
        )}

        <label className={`drop-zone${canWrite ? '' : ' disabled'}`} title={canWrite ? undefined : READ_ONLY_HINT}>
          <span>⇧</span>
          <strong>
            {!canWrite
              ? 'Uploading needs edit access'
              : data.descriptionDocument
                ? 'Click to replace the document'
                : 'Click to upload'}
          </strong>
          <p>PDF, Word, Excel, PowerPoint or TXT</p>
          <small>Max {data.policy.maxUploadMb} MB · required before analysis</small>
          <input
            type="file"
            accept={UPLOAD_ACCEPT}
            disabled={!canWrite}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) uploadDescription.mutate(file);
              event.target.value = '';
            }}
          />
        </label>

      </article>

      <article className="panel reference-panel">
        <div className="panel-head">
          <div>
            <h2>Optional reference sources</h2>
            <p>Upload a small, classified source only to prefill or verify structured data</p>
          </div>
          <span className="policy-chip">
            Max {data.policy.maxFilesPerGroup} files/group · {data.policy.maxUploadMb} MB/file
          </span>
        </div>
        <div className="reference-groups">
          {data.referenceGroups.map((group) => {
            const full = group.files.length >= data.policy.maxFilesPerGroup;
            return (
              <div className="reference-group" key={group.group}>
                <span className={`domain-glyph ${group.tone}`}>{group.glyph}</span>
                <div>
                  <strong>{group.title}</strong>
                  <small>{group.hint}</small>
                  {group.files.length === 0 ? (
                    <div className="empty-file">No file — direct input will be used</div>
                  ) : (
                    group.files.map((file) => (
                      <div
                        key={file.id}
                        className={`file-result ${file.status === 'VERIFIED' ? 'ok-file' : 'warning-file'}`}
                      >
                        <span>
                          {file.status === 'VERIFIED' ? '✓' : '!'} {file.fileName} <em>{file.message}</em>
                        </span>
                        {/*
                          Without this there is no way to take a file back out of a group, which is
                          how a message from a file the PM had already moved on from stayed on
                          screen. An unreadable file is also cleared automatically by the next
                          upload to the same group.
                        */}
                        <button
                          type="button"
                          className="file-remove"
                          title={canWrite ? `Remove ${file.fileName}` : READ_ONLY_HINT}
                          aria-label={`Remove ${file.fileName}`}
                          onClick={() => removeReferenceFile.mutate(file.id)}
                          disabled={!canWrite || removeReferenceFile.isPending}
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <label
                  className={full || !canWrite ? 'disabled' : undefined}
                  title={!canWrite ? READ_ONLY_HINT : full ? 'Remove a file before adding another' : undefined}
                >
                  {group.files.length === 0 ? 'Add' : full ? 'Full' : 'Add another'}
                  <input
                    type="file"
                    accept={UPLOAD_ACCEPT}
                    disabled={full || !canWrite}
                    ref={(element) => {
                      fileInputs.current[group.group] = element;
                    }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) uploadReference.mutate({ group: group.group, file });
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>
            );
          })}
        </div>
      </article>
      </>

      {/* Full width now: the "Missing information" aside that used to sit beside this form is gone. */}
      <div className="input-single">
        <form className="panel form-panel" onSubmit={(event) => event.preventDefault()}>
          <div className="section-title">
            <div>
              <div>
                <h2>Minimum project profile</h2>
              </div>
            </div>
          </div>

          {/*
            Three fields, fixed, on one row — and only the first is an input-form field. Type and
            approach live on `Project`, not on `ProjectInputValue`: type decides which document
            catalog applies, approach decides whether the analysis recommends a governance model or
            assesses the one the PM already chose. Both save on change; there is no draft worth
            keeping for a dropdown.
          */}
          <div className="form-grid profile-row">
            <label>
              {nameField?.label ?? 'Project name'} *
              {nameField && (
                <input
                  type="text"
                  value={valueOf(nameField)}
                  disabled={!canWrite}
                  onChange={(event) => change(nameField, event.target.value)}
                />
              )}
            </label>
            <label>
              Project type *
              <select
                value={workspace.data?.category ?? ''}
                disabled={!canWrite}
                onChange={(event) => event.target.value && setProjectField.mutate({ category: event.target.value })}
              >
                {/*
                  A project from before these types existed may have none. It is named by its earlier
                  type, and not selectable: that type is no longer one a PM can pick.
                */}
                {!workspace.data?.category && workspace.data && (
                  <option value="" disabled>
                    {categoryLabel(workspace.data)} (earlier type) — pick one
                  </option>
                )}
                {PROJECT_CATEGORIES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Management approach
              <select
                value={workspace.data?.preferredApproach ?? ''}
                disabled={!canWrite}
                onChange={(event) => setProjectField.mutate({ preferredApproach: event.target.value || null })}
              >
                {/*
                  "Not decided yet" is a real answer, not a blank. Choosing it is what asks the
                  analysis to recommend a model; naming one asks it to assess that model instead.
                */}
                <option value="">Not decided yet — recommend one for me</option>
                {GOVERNANCE_MODELS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {contractField && (
              <label>
                {contractField.label}
                <select
                  value={valueOf(contractField)}
                  disabled={!canWrite}
                  onChange={(event) => change(contractField, event.target.value)}
                >
                  <option value="">Not specified</option>
                  {contractField.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {teamSizeField && (
              <label>
                {teamSizeField.label}
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  placeholder="People on the team"
                  value={valueOf(teamSizeField)}
                  disabled={!canWrite}
                  onChange={(event) => change(teamSizeField, event.target.value.replace(/[^\d]/g, ''))}
                />
              </label>
            )}
          </div>


          <div className="section-title second custom-head">
            <div>
              <span>+</span>
              <div>
                <h2>Custom context</h2>
                <p>Facts the form has no field for — the analysis, assessment, documents and agent all read them</p>
              </div>
            </div>
            <button
              type="button"
              className="ghost"
              disabled={!canWrite}
              title={canWrite ? undefined : READ_ONLY_HINT}
              onClick={() => {
                // A second click goes back to the row already open rather than stacking empty ones.
                if (!newField) setNewField({ name: '', value: '' });
                setTimeout(() => newFieldNameRef.current?.focus(), 0);
              }}
            >
              + Add custom field
            </button>
          </div>

          <div className="custom-fields">
            {data.customFields.length === 0 && !newField && (
              <p className="custom-fields-empty">
                No custom context yet. Add a fact the form has no field for — the analysis, the assessment, document
                drafting and the planning agent all read it.
              </p>
            )}
            {data.customFields.map((field) => (
              <CustomFieldRow
                key={field.id}
                field={field}
                canWrite={canWrite}
                onSave={(changes) => updateField.mutate({ id: field.id, changes })}
                onRemove={() => removeField.mutate(field.id)}
              />
            ))}
            {newField && (
              <NewCustomFieldRow
                draft={newField}
                nameRef={newFieldNameRef}
                saving={addField.isPending}
                onChange={setNewField}
                onSave={() => {
                  const name = newField.name.trim();
                  if (name && !addField.isPending) addField.mutate({ name, value: newField.value.trim() });
                }}
                onCancel={() => setNewField(null)}
              />
            )}
          </div>

          <div className="form-actions">
            <span>
              <i>✓</i>{' '}
              {save.isPending ? 'Saving…' : savedAt ? `Auto-saved at ${savedAt.toLocaleTimeString()}` : 'Auto-save on'}
            </span>
            <button
              type="button"
              className="secondary"
              onClick={() => save.mutate(pendingDraftValues())}
              disabled={!canWrite || save.isPending}
              title={canWrite ? 'Save what you have typed without verifying it' : READ_ONLY_HINT}
            >
              Save draft
            </button>
            {/*
              One action, not two. "Verify input" used to read the documents into the form so the
              PM could confirm each value; the analysis now reads them directly and answers about
              the project instead, so there is nothing left to promote — a typed value is the PM's
              own and is verified on save.
            */}
            {/*
              Stays enabled when something is missing, and says what. A disabled button fires no
              click event, so it can never explain itself — the PM was left with a grey control and
              a tooltip they had to go looking for. Pressing it now names the gap.
            */}
            {/*
              The last button follows the project's state. Before a governance model is confirmed
              there is no plan, so "analyse it" is the right action; after one, analysing the whole
              project again is the wrong question — what has changed is the right one.
            */}
            {!hasPlan ? (
              <button
                type="button"
                className="primary"
                data-tour="analyze"
                onClick={startAnalysis}
                disabled={!canWrite || analyze.isPending}
                title={
                  canWrite
                    ? 'Read every uploaded document, then assess the project against the FPT standard and its customer’s checklist'
                    : READ_ONLY_HINT
                }
              >
                {/* Three steps in one request, which takes a few minutes — say so while it runs. */}
                {analyze.isPending ? '✦ Analyzing & assessing — a few minutes…' : '✦ Analyze planning needs'}
              </button>
            ) : (
              /* A confirmed plan changes in its own step — this only takes the PM there. */
              <button
                type="button"
                className="primary"
                onClick={() => onNavigate('update')}
                title="Record something that has changed since the plan was confirmed"
              >
                ⇄ Update planning →
              </button>
            )}
          </div>
        </form>

      </div>

    </section>
  );
}

/**
 * The row "+ Add custom field" opens: the same two boxes as a saved field, typed into in place.
 *
 * It is saved once it has a name — on Enter, on *Add*, or when focus leaves the row altogether, so a
 * PM who types a fact and clicks elsewhere does not lose it. Leaving with no name keeps the row
 * open rather than saving a field nobody named; Escape or × discards it.
 */
function NewCustomFieldRow({
  draft,
  nameRef,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  draft: { name: string; value: string };
  nameRef: RefObject<HTMLInputElement>;
  saving: boolean;
  onChange: (draft: { name: string; value: string }) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault(); // Enter adds the field rather than submitting the surrounding form
      onSave();
    } else if (event.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div
      className="custom-field-new"
      onBlur={(event) => {
        // Focus moving between the row's own boxes and buttons is not leaving it.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null) && draft.name.trim()) onSave();
      }}
    >
      <label>
        Field name
        <input
          ref={nameRef}
          value={draft.name}
          placeholder="e.g. Release blackout"
          maxLength={120}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          onKeyDown={keys}
        />
      </label>
      <label>
        Value
        <input
          value={draft.value}
          placeholder="e.g. No production deployments 15–31 December"
          maxLength={4000}
          onChange={(event) => onChange({ ...draft, value: event.target.value })}
          onKeyDown={keys}
        />
      </label>
      <div className="custom-field-new-actions">
        <button type="button" className="primary small" disabled={!draft.name.trim() || saving} onClick={onSave}>
          {saving ? 'Adding…' : 'Add'}
        </button>
        <button type="button" className="remove-field" title="Discard this field" onClick={onCancel}>
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * One custom-context field. Typed into freely and saved when the PM leaves the box (or presses
 * Enter) — only when something actually changed, so tabbing through does not write the row again.
 * The inputs used to be `readOnly` with no route to save to, which is why nothing could be typed.
 */
function CustomFieldRow({
  field,
  canWrite,
  onSave,
  onRemove,
}: {
  field: { id: string; name: string; value: string | null };
  canWrite: boolean;
  onSave: (changes: { name?: string; value?: string | null }) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState(field.name);
  const [value, setValue] = useState(field.value ?? '');

  // A refetch after someone else's save brings the stored text back in.
  useEffect(() => setName(field.name), [field.name]);
  useEffect(() => setValue(field.value ?? ''), [field.value]);

  // Both read the box itself, not state: a blur that lands in the same tick as the last keystroke
  // (paste then Tab, autofill) would otherwise save the text from before it.
  const saveName = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.currentTarget.value.trim();
    if (!next) {
      setName(field.name); // a field must keep a name; an emptied box reverts
      return;
    }
    if (next !== field.name) onSave({ name: next });
  };
  const saveValue = (event: FocusEvent<HTMLInputElement>) => {
    const next = event.currentTarget.value.trim();
    if (next !== (field.value ?? '')) onSave({ value: next || null });
  };
  // Enter saves rather than submitting the surrounding form.
  const enterSaves = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  return (
    <div>
      <label>
        Field name
        <input
          value={name}
          readOnly={!canWrite}
          title={canWrite ? undefined : READ_ONLY_HINT}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          onBlur={saveName}
          onKeyDown={enterSaves}
        />
      </label>
      <label>
        Value
        <input
          value={value}
          readOnly={!canWrite}
          title={canWrite ? undefined : READ_ONLY_HINT}
          placeholder={canWrite ? 'e.g. No production deployments 15–31 December' : undefined}
          maxLength={4000}
          onChange={(event) => setValue(event.target.value)}
          onBlur={saveValue}
          onKeyDown={enterSaves}
        />
      </label>
      <button
        type="button"
        className="remove-field"
        disabled={!canWrite}
        title={canWrite ? 'Remove this field' : READ_ONLY_HINT}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
