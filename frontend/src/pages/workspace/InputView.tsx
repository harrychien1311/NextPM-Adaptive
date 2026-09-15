import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inputApi, rulesApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { useProjectWrite } from '../../hooks/useProjectWrite';
import { CustomerConfirmBanner } from './CustomerConfirmBanner';
import type { InputField } from '../../api/types';
import type { WorkspaceView } from '../WorkspacePage';

/** One wording for every disabled control, so a reader is told why rather than left guessing. */
const READ_ONLY_HINT = 'You have view-only access to this project';

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

  const { data, isLoading } = useQuery({
    queryKey: ['input', projectId],
    queryFn: () => inputApi.profile(projectId),
  });

  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [fieldDrawerOpen, setFieldDrawerOpen] = useState(false);

  /**
   * Optional fields the PM has asked to see even though nothing has answered them yet.
   *
   * Only two fields per project type are required, so showing all thirty at once is what made this
   * form read as a wall of empty boxes. The rest appear on their own once something fills them —
   * *Verify input* is the usual way — and this is the escape hatch for a PM who wants one in front
   * of them from the start.
   *
   * Kept in the browser rather than on the server: it is a per-viewer display preference, not
   * project data, and nothing downstream reads it.
   */
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const revealKey = `nextpm:input-revealed:${projectId}`;

  useEffect(() => {
    setDraft({});
    setFieldDrawerOpen(false);
    try {
      const stored = window.localStorage.getItem(`nextpm:input-revealed:${projectId}`);
      setRevealed(stored ? (JSON.parse(stored) as Record<string, boolean>) : {});
    } catch {
      // A blocked or corrupted store is not worth a broken screen — start from the default.
      setRevealed({});
    }
  }, [projectId]);

  const reveal = (definitionId: string, show: boolean) => {
    setRevealed((current) => {
      const next = { ...current, [definitionId]: show };
      try {
        window.localStorage.setItem(revealKey, JSON.stringify(next));
      } catch {
        // Preference lost on reload; the form still works, which is what matters.
      }
      return next;
    });
  };

  const save = useMutation({
    mutationFn: (values: { definitionId: string; value: string | null }[]) => inputApi.save(projectId, values),
    onSuccess: (profile) => {
      queryClient.setQueryData(['input', projectId], profile);
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      setSavedAt(new Date());
    },
  });

  const autoSave = useDebouncedCallback((definitionId: string, value: string | null) => {
    save.mutate([{ definitionId, value }]);
  }, 900);

  /**
   * Reads the uploaded documents into the form, then verifies the PM's own answers. It stays on
   * this screen on purpose: prefilled values arrive unverified, and the PM is meant to look at
   * them before asking for a governance model.
   */
  const verify = useMutation({
    mutationFn: () => inputApi.verify(projectId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });

      // A proposed customer is the one result worth interrupting for — it gates the customer
      // checklist and the kickoff template, and it is waiting on a decision only the PM can make.
      if (result.customerSuggestion) {
        notify({
          title: `Is this project for ${result.customerSuggestion.name}?`,
          detail: 'Confirm it above the form — nothing has been changed yet.',
        });
      }

      const read = result.documentsRead
        ? `Read ${result.documentsRead} document${result.documentsRead === 1 ? '' : 's'}. `
        : 'No uploaded documents to read. ';
      const filled = result.prefilled
        ? `Prefilled ${result.prefilled} field${result.prefilled === 1 ? '' : 's'} — review them, then verify again to confirm. `
        : result.documentsRead
          ? 'Nothing new could be answered from them — fill the rest in yourself. '
          : '';
      notify({
        title: `${result.verified} data point${result.verified === 1 ? '' : 's'} verified`,
        detail: `${read}${filled}`.trim(),
      });
      if (result.documentsRead && result.provider === 'mock') {
        notify({
          title: 'Document reading is unavailable',
          detail:
            'The AI provider could not be reached, so only exact keyword matches were applied. Check AI_PROVIDER and ANTHROPIC_API_KEY.',
        });
      }
    },
    onError: (error) =>
      notify({ title: 'Verification failed', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  /** The explicit "ask the AI" step — runs Skill 1, then opens the Governance Model screen. */
  const suggestModel = useMutation({
    mutationFn: () => rulesApi.evaluate(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['approach', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      notify({ title: 'Recommendation ready', detail: 'Opening the governance model options.' });
      setTimeout(() => onNavigate('approach'), 350);
    },
    onError: (error) =>
      notify({
        title: 'Could not get a recommendation',
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

  const resolve = useMutation({
    mutationFn: ({ actionId, value }: { actionId: string; value: string }) =>
      inputApi.resolveAction(projectId, actionId, value),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      notify({ title: 'Suggested value selected', detail: `${variables.value} is now a PM-confirmed input.` });
    },
  });

  const uploadReference = useMutation({
    mutationFn: ({ group, file }: { group: string; file: File }) => inputApi.uploadReference(projectId, group, file),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
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
      notify({
        title: 'Project description saved',
        detail: `${file.name} will be read the next time you ask the AI for a governance-model recommendation.`,
      });
    },
    onError: (error) => notify({ title: 'Upload rejected', detail: (error as Error).message }),
  });

  const removeDescription = useMutation({
    mutationFn: (id: string) => inputApi.removeReference(projectId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['input', projectId] }),
  });

  /** The same call, from the reference groups — without it a PM cannot clear a file they added. */
  const removeReferenceFile = useMutation({
    mutationFn: (id: string) => inputApi.removeReference(projectId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['input', projectId] }),
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
   * A field earns its place on screen by being required, by having an answer, or by the PM asking
   * for it. "Having an answer" is what makes *Verify input* reveal exactly the fields the uploaded
   * documents could fill: they arrive with a value, so they stop being hidden.
   */
  const isAnswered = (field: InputField) => Boolean(valueOf(field));
  const isVisible = (field: InputField) => field.required || isAnswered(field) || revealed[field.definitionId];

  const visibleFields = data.fields.filter(isVisible);
  const hiddenFields = data.fields.filter((field) => !isVisible(field));
  const optionalFields = data.fields.filter((field) => !field.required);

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
        <div className="completion">
          <span>Input readiness</span>
          <strong>{data.readiness}%</strong>
          <div>
            <i style={{ width: `${data.readiness}%` }} />
          </div>
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
          <span className="required-chip">Optional</span>
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
          <p>PDF, DOCX or TXT — read as text</p>
          <small>Max {data.policy.maxUploadMb} MB</small>
          <input
            type="file"
            accept=".pdf,.docx,.doc,.txt"
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
                    accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
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

      <div className="content-split input-split">
        <form className="panel form-panel" onSubmit={(event) => event.preventDefault()}>
          <div className="section-title">
            <div>
              <span>01</span>
              <div>
                <h2>Minimum project profile</h2>
                <p>Required signals for approach and document selection</p>
              </div>
            </div>
            <div className="section-title-actions">
              <b>
                {visibleFields.length} of {data.fields.length} shown
              </b>
              <button
                type="button"
                className="primary icon-only"
                onClick={() => setFieldDrawerOpen(true)}
                title="Choose which fields to show"
                aria-label="Choose which fields to show"
              >
                ⚙
              </button>
            </div>
          </div>

          <div className="form-grid">
            {visibleFields.map((field) => (
              <label key={field.definitionId}>
                {field.label}
                {field.required ? ' *' : ''}
                {field.source === 'AI_SUGGESTED' && !field.verified && (
                  <span className="required-chip ai-suggested-chip">AI suggested — review</span>
                )}
                {field.fieldType === 'SELECT' ? (
                  <select
                    value={valueOf(field)}
                    disabled={!canWrite}
                    onChange={(event) => change(field, event.target.value)}
                  >
                    <option value="">— select —</option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : field.fieldType === 'DATE_RANGE' ? (
                  <div className="dual">
                    <input
                      type="date"
                      value={valueOf(field).split('..')[0] ?? ''}
                      disabled={!canWrite}
                      onChange={(event) =>
                        change(field, `${event.target.value}..${valueOf(field).split('..')[1] ?? ''}`)
                      }
                    />
                    <input
                      type="date"
                      value={valueOf(field).split('..')[1] ?? ''}
                      disabled={!canWrite}
                      onChange={(event) =>
                        change(field, `${valueOf(field).split('..')[0] ?? ''}..${event.target.value}`)
                      }
                    />
                  </div>
                ) : (
                  <input
                    type={field.fieldType === 'DATE' ? 'date' : field.fieldType === 'NUMBER' ? 'number' : 'text'}
                    value={valueOf(field)}
                    disabled={!canWrite}
                    onChange={(event) => change(field, event.target.value)}
                  />
                )}
              </label>
            ))}
          </div>

          {/*
            Says plainly that the form is not the whole form. Hiding fields without saying so would
            leave a PM wondering where the schedule questions went.
          */}
          {hiddenFields.length > 0 && (
            <p className="hidden-fields-note">
              <b>{hiddenFields.length}</b> optional field{hiddenFields.length === 1 ? ' is' : 's are'} hidden. Press{' '}
              <b>Verify input</b> and any the uploaded documents can answer will appear filled in, or{' '}
              <button type="button" className="text-button" onClick={() => setFieldDrawerOpen(true)}>
                choose them yourself
              </button>
              .
            </p>
          )}

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

          {/*
            Sits directly above the three buttons it describes. It explains what pressing them does,
            so it belongs where the PM is about to press one — not at the top of the upload panel,
            several screens away from the action.
          */}
          <div className="extract-note form-note">
            <span>✦</span>
            <div>
              <strong>What happens next</strong>
              <p>
                <b>Verify input</b> reads every uploaded document into this form: fields it can answer appear filled
                in and marked AI suggested, and the rest stay hidden until something answers them. It then marks your
                own answers verified. <b>✦ Suggest governance model</b> reads the description document alongside your
                verified inputs and proposes a model with a confidence score and alternatives. Nothing here is applied
                without your confirmation.
              </p>
            </div>
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
            <button
              type="button"
              className="secondary"
              onClick={() => verify.mutate()}
              disabled={!canWrite || verify.isPending || suggestModel.isPending}
              title={canWrite ? 'Read the uploaded documents into the form, then confirm your answers' : READ_ONLY_HINT}
            >
              {verify.isPending ? 'Reading documents…' : 'Verify input'}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => suggestModel.mutate()}
              disabled={!canWrite || suggestModel.isPending || verify.isPending}
              title={canWrite ? 'Ask the AI to recommend a governance model from the verified inputs' : READ_ONLY_HINT}
            >
              {suggestModel.isPending ? 'Asking AI…' : '✦ Suggest governance model'}
            </button>
          </div>
        </form>

        <aside className="context-aside">
          {/*
            The "Rule verification" card used to sit here restating the Input readiness meter in the
            page header with a second set of numbers. One reading of the same thing is enough.
          */}
          <article className="panel">
            <h3>Missing information</h3>
            {data.missingInformation.length === 0 && (
              <div className="program-empty">Nothing outstanding right now.</div>
            )}
            {data.missingInformation.map((item) => (
              <div className="missing" key={item.id}>
                <span>!</span>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                  {item.suggestions.length > 0 ? (
                    <div className="suggested-values">
                      {item.suggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          disabled={!canWrite}
                          title={canWrite ? undefined : READ_ONLY_HINT}
                          onClick={() => resolve.mutate({ actionId: item.id, value: suggestion })}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button
                      className="text-button add-answer"
                      disabled={!canWrite}
                      title={canWrite ? undefined : READ_ONLY_HINT}
                      onClick={() => {
                        const value = window.prompt(item.title, '');
                        if (value) resolve.mutate({ actionId: item.id, value });
                      }}
                    >
                      + Provide value
                    </button>
                  )}
                </div>
              </div>
            ))}
          </article>
        </aside>
      </div>

      {/*
        The same drawer pattern as the dashboard's ⚙, for the same reason: a screen that decides
        what to show you needs one obvious place to override it. A field that already has an answer
        is locked on — hiding a filled-in field would hide the PM's own data from them.
      */}
      <div className={`dashboard-drawer input-field-drawer${fieldDrawerOpen ? ' open' : ''}`}>
        <div className="drawer-head">
          <div>
            <strong>Custom input</strong>
            <span>Choose which optional fields stay on the form</span>
          </div>
          <button onClick={() => setFieldDrawerOpen(false)}>×</button>
        </div>
        <div className="dashboard-options">
          {optionalFields.map((field) => {
            const answered = isAnswered(field);
            return (
              <label key={field.definitionId} className={answered ? 'locked' : undefined}>
                <input
                  type="checkbox"
                  checked={answered || Boolean(revealed[field.definitionId])}
                  disabled={answered}
                  onChange={(event) => reveal(field.definitionId, event.target.checked)}
                />{' '}
                {field.label}
                {answered && <em> · answered</em>}
              </label>
            );
          })}
          {optionalFields.length === 0 && <p className="program-empty">Every field on this form is required.</p>}
        </div>
        <button
          type="button"
          className="secondary full"
          onClick={() => {
            const all = Object.fromEntries(optionalFields.map((field) => [field.definitionId, true]));
            setRevealed(all);
            try {
              window.localStorage.setItem(revealKey, JSON.stringify(all));
            } catch {
              // See `reveal` — the preference is a convenience, never a requirement.
            }
          }}
        >
          Show every field
        </button>
        <button className="primary full" onClick={() => setFieldDrawerOpen(false)}>
          Done
        </button>
      </div>
    </section>
  );
}
