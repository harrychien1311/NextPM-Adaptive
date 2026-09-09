import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inputApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import type { InputField } from '../../api/types';
import type { WorkspaceView } from '../WorkspacePage';

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

  const { data, isLoading } = useQuery({
    queryKey: ['input', projectId],
    queryFn: () => inputApi.profile(projectId),
  });

  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  useEffect(() => {
    setDraft({});
  }, [projectId]);

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

  const verify = useMutation({
    mutationFn: () => inputApi.verify(projectId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      notify({
        title: 'Verification complete',
        detail: `${result.verified} data points verified. Get the AI governance-model recommendation next.`,
      });
      setTimeout(() => onNavigate('approach'), 450);
    },
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
          <span>
            Structured answers drive the AI recommendation. Uploaded files can prefill or verify answers, but are not required to
            create the plan.
          </span>
        </div>
        <div className="completion">
          <span>Input readiness</span>
          <strong>{data.readiness}%</strong>
          <div>
            <i style={{ width: `${data.readiness}%` }} />
          </div>
        </div>
      </div>

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
            <b>{data.counters.total} required</b>
          </div>

          <div className="form-grid">
            {data.fields.map((field) => (
              <label key={field.definitionId}>
                {field.label}
                {field.required ? ' *' : ''}
                {field.source === 'AI_SUGGESTED' && !field.verified && (
                  <span className="required-chip ai-suggested-chip">AI suggested — review</span>
                )}
                {field.fieldType === 'SELECT' ? (
                  <select value={valueOf(field)} onChange={(event) => change(field, event.target.value)}>
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
                      onChange={(event) =>
                        change(field, `${event.target.value}..${valueOf(field).split('..')[1] ?? ''}`)
                      }
                    />
                    <input
                      type="date"
                      value={valueOf(field).split('..')[1] ?? ''}
                      onChange={(event) =>
                        change(field, `${valueOf(field).split('..')[0] ?? ''}..${event.target.value}`)
                      }
                    />
                  </div>
                ) : (
                  <input
                    type={field.fieldType === 'DATE' ? 'date' : field.fieldType === 'NUMBER' ? 'number' : 'text'}
                    value={valueOf(field)}
                    onChange={(event) => change(field, event.target.value)}
                  />
                )}
              </label>
            ))}
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
                <button type="button" className="remove-field" onClick={() => removeField.mutate(field.id)}>
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
            <button type="button" className="secondary" onClick={() => setSavedAt(new Date())}>
              Save draft
            </button>
            <button type="button" className="primary" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? 'Verifying…' : 'Verify input & continue'}
            </button>
          </div>
        </form>

        <aside className="context-aside">
          <article className="panel verification-card">
            <span className="ai-label">RULE VERIFICATION</span>
            <h3>
              {data.counters.verified} of {data.counters.total} required data points verified
            </h3>
            <div className="verify-meter">
              <i style={{ width: `${Math.round((data.counters.verified / Math.max(data.counters.total, 1)) * 100)}%` }} />
            </div>
            <div className="verify-counts">
              <span>
                <b>{data.counters.pmInput}</b>PM input
              </span>
              <span>
                <b>{data.counters.fileReference}</b>File reference
              </span>
              <span className="warn-text">
                <b>{data.counters.missing}</b>Missing
              </span>
            </div>
          </article>

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
                          onClick={() => resolve.mutate({ actionId: item.id, value: suggestion })}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <button
                      className="text-button add-answer"
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
                disabled={removeDescription.isPending}
              >
                Remove
              </button>
            </div>
          </div>
        )}

        <label className="drop-zone">
          <span>⇧</span>
          <strong>{data.descriptionDocument ? 'Click to replace the document' : 'Click to upload'}</strong>
          <p>PDF, DOCX or TXT — read as text</p>
          <small>Max {data.policy.maxUploadMb} MB</small>
          <input
            type="file"
            accept=".pdf,.docx,.doc,.txt"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) uploadDescription.mutate(file);
              event.target.value = '';
            }}
          />
        </label>

        <div className="extract-note">
          <span>✦</span>
          <div>
            <strong>What happens next</strong>
            <p>
              When you ask the AI for a governance-model recommendation on the next screen, it reads this document
              together with your verified inputs, proposes values for empty fields above (marked AI suggested,
              unverified) and returns a recommended governance model with a confidence score and alternatives.
              Nothing here is applied without your confirmation.
            </p>
          </div>
        </div>
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
          {data.referenceGroups.map((group) => (
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
                      {file.status === 'VERIFIED' ? '✓' : '!'} {file.fileName} <em>{file.message}</em>
                    </div>
                  ))
                )}
              </div>
              <label>
                {group.files.length ? 'Replace' : 'Add'}
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
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
          ))}
        </div>
        <div className="reference-note">
          <span>✦</span>
          <p>
            <strong>Verification sequence:</strong> classify file → extract candidate values → compare with PM input →
            flag missing/conflict → PM confirms. Files never become approved facts automatically.
          </p>
        </div>
      </article>
    </section>
  );
}
