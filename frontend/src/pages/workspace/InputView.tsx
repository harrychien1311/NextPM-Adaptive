import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inputApi, projectApi, rulesApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { useProjectWrite } from '../../hooks/useProjectWrite';
import { CustomerConfirmBanner } from './CustomerConfirmBanner';
import type { InputField, ProjectType } from '../../api/types';
import type { WorkspaceView } from '../WorkspacePage';

/** One wording for every disabled control, so a reader is told why rather than left guessing. */
const READ_ONLY_HINT = 'You have view-only access to this project';

/** Seeded from the Create Project dialog; changing it here changes which document catalog applies. */
const PROJECT_TYPES: { value: ProjectType; label: string }[] = [
  { value: 'SI', label: 'SI — System Integration' },
  { value: 'SM', label: 'SM — Service Management' },
  { value: 'PRODUCT', label: 'Product' },
];

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
];

/** Every format `lib/extract-text.ts` is asked to read, in one place so both upload boxes agree. */
const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt';

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
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['approach', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['studio', projectId] }),
        // The analysis is what opens the PM action center's entries, so the dashboard changes most
        // of all here.
        refreshDashboard(),
      ]);
      notify({ title: 'Analysis ready', detail: 'Opening Planning Review.' });
      setTimeout(() => onNavigate('approach'), 350);
    },
    onError: (error) =>
      notify({
        title: 'Analysis failed',
        detail: error instanceof ApiError ? error.message : 'Unexpected error',
      }),
  });

  const addField = useMutation({
    mutationFn: (name: string) => inputApi.addCustomField(projectId, { name, useIn: 'BOTH' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['input', projectId] }),
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
      refreshDashboard();
      notify({
        title: 'Project description saved',
        detail: `${file.name} will be read the next time you ask the AI for a governance-model recommendation.`,
      });
    },
    onError: (error) => notify({ title: 'Upload rejected', detail: (error as Error).message }),
  });

  /**
   * Saves a project-level answer. Changing the type re-reads the whole input schema and the
   * document catalog, so the input profile is invalidated alongside the workspace.
   */
  const setProjectField = useMutation({
    mutationFn: (patch: { type?: ProjectType; preferredApproach?: string | null }) =>
      projectApi.update(projectId, patch),
    onSuccess: async (_result, patch) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['workspace', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['input', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['studio', projectId] }),
        // Changing the type swaps the whole document catalog, so Document progress changes with it.
        refreshDashboard(),
      ]);
      if (patch.type) {
        notify({
          title: 'Project type changed',
          detail: 'The input form and the document catalog for this project changed with it.',
        });
      }
    },
    onError: (error) => notify({ title: 'Could not save', detail: (error as Error).message }),
  });

  const removeDescription = useMutation({
    mutationFn: (id: string) => inputApi.removeReference(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      refreshDashboard();
    },
  });

  /** The same call, from the reference groups — without it a PM cannot clear a file they added. */
  const removeReferenceFile = useMutation({
    mutationFn: (id: string) => inputApi.removeReference(projectId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      refreshDashboard();
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
      */}
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
                value={workspace.data?.type ?? ''}
                disabled={!canWrite}
                onChange={(event) => setProjectField.mutate({ type: event.target.value as ProjectType })}
              >
                {PROJECT_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
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
          </div>


          <div className="section-title second custom-head">
            <div>
              <span>+</span>
              <div>
                <h2>Custom context</h2>
                <p>Add only signals that affect a rule or generated section</p>
              </div>
            </div>
            <button
              type="button"
              className="ghost"
              disabled={!canWrite}
              title={canWrite ? undefined : READ_ONLY_HINT}
              onClick={() => {
                const name = window.prompt('Field name', 'Release blackout');
                if (name) addField.mutate(name);
              }}
            >
              + Add custom field
            </button>
          </div>

          <div className="custom-fields">
            {data.customFields.map((field) => (
              <div key={field.id}>
                <label>
                  Field name
                  <input defaultValue={field.name} readOnly />
                </label>
                <label>
                  Value
                  <input defaultValue={field.value ?? ''} readOnly />
                </label>
                <label>
                  Use in
                  <select defaultValue={field.useIn} disabled>
                    <option value="RULES">Risk &amp; schedule rules</option>
                    <option value="DOCUMENT">Document content only</option>
                    <option value="BOTH">Both</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="remove-field"
                  disabled={!canWrite}
                  title={canWrite ? undefined : READ_ONLY_HINT}
                  onClick={() => removeField.mutate(field.id)}
                >
                  ×
                </button>
              </div>
            ))}
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
            <button
              type="button"
              className="primary"
              onClick={startAnalysis}
              disabled={!canWrite || analyze.isPending}
              title={
                canWrite
                  ? 'Read every uploaded document and return the project overview, the approach advisory and the planning gaps'
                  : READ_ONLY_HINT
              }
            >
              {analyze.isPending ? '✦ Analyzing…' : '✦ Analyze planning needs'}
            </button>
          </div>
        </form>

      </div>

    </section>
  );
}
