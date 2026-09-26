import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints';
import type { CustomerReferenceKind, CustomerReferenceSummary, CustomerSummary, CustomerTemplateSummary } from '../api/types';
import { useAuth } from '../store/auth';
import { useToast } from '../components/Toast';
import { Backdrop, ModalShell } from '../components/Modal';
import { AccountShell, isHouseLibrary, orderLibraries } from '../components/AccountShell';
import { ApiError } from '../api/client';
import { ChecklistPreview } from './ChecklistPreview';

/**
 * Account Libraries · Library Center (formerly the customer library).
 *
 * One library per account. The **FPT Standard** — the customer holding the `*` alias — is the
 * mandatory baseline every project gets; an **account library** (SKAX, LG CNS…) is laid on top for
 * the projects whose Customer field matches its aliases: its checklist is scored beside the FPT
 * standard, and its templates take precedence over the FPT ones for the same document.
 *
 * Its reason to exist is unchanged: a checklist belongs to an *account*, not to a project, so it is
 * uploaded here once and every project for that account is assessed against it, instead of the PM
 * re-uploading the same file into each workspace. Each library's content sits on two tabs —
 * Governance (the checklist) and Templates (the document templates, filled in place).
 *
 * A project finds its library by matching what the PM typed into the project's free-text Customer
 * field against the aliases. The field is free text on purpose, so the aliases are what make
 * "SK AX", "SK C&C" and "AGS" land on the same library.
 *
 * Parsing is shown, never hidden: every checklist reports what the parser read, and the original
 * file stays downloadable so the numbers can be checked against it.
 */
export function AccountLibraryPage() {
  const { user } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const library = useQuery({ queryKey: ['customers'], queryFn: customersApi.list });

  const [createOpen, setCreateOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<CustomerSummary | null>(null);
  const [previewChecklist, setPreviewChecklist] = useState<{ id: string; name: string } | null>(null);
  const [tab, setTab] = useState<LibraryTab>('governance');

  const canWrite = user?.role === 'PROGRAM_OWNER' || user?.role === 'ADMIN';

  // "+ New Library" in the sidebar arrives as ?new=1, from whichever screen it was pressed on.
  useEffect(() => {
    if (params.get('new') !== '1') return;
    if (canWrite) setCreateOpen(true);
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
  }, [params, setParams, canWrite]);

  const fail = (title: string) => (error: unknown) =>
    notify({ title, detail: error instanceof ApiError ? error.message : 'Unexpected error' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['customers'] });
  const select = (id: string) => setParams({ lib: id });

  const createCustomer = useMutation({
    mutationFn: customersApi.create,
    onSuccess: (customer) => {
      refresh();
      setCreateOpen(false);
      select(customer.id);
      notify({ title: `${customer.name} library added`, detail: 'Now upload its checklist and templates.' });
    },
    onError: fail('Could not add the library'),
  });

  const updateCustomer = useMutation({
    mutationFn: ({ customerId, body }: { customerId: string; body: { name?: string; aliases?: string[] } }) =>
      customersApi.update(customerId, body),
    onSuccess: (customer) => {
      refresh();
      setEditCustomer(null);
      notify({
        title: 'Library updated',
        detail: `${customer.name} — ${customer.aliases.length} alias${customer.aliases.length === 1 ? '' : 'es'}. Projects re-match on their next load.`,
      });
    },
    onError: (error) => notify({ title: 'Could not update the library', detail: (error as Error).message }),
  });

  const removeCustomer = useMutation({
    mutationFn: customersApi.remove,
    onSuccess: () => {
      refresh();
      setEditCustomer(null);
      setParams({});
      notify({ title: 'Library removed' });
    },
    onError: fail('Could not remove the library'),
  });

  const uploadChecklist = useMutation({
    mutationFn: ({ customerId, file }: { customerId: string; file: File }) =>
      customersApi.uploadChecklist(customerId, file, file.name),
    onSuccess: (result) => {
      refresh();
      notify({ title: `Checklist v${result.version} uploaded`, detail: result.parsed });
    },
    onError: fail('Could not upload checklist'),
  });

  const uploadTemplate = useMutation({
    mutationFn: ({ customerId, file, documentType }: { customerId: string; file: File; documentType: string }) =>
      customersApi.uploadTemplate(customerId, file, documentType),
    onSuccess: (result) => {
      refresh();
      notify({ title: `Template v${result.version} uploaded`, detail: result.parseNote });
    },
    onError: fail('Could not upload template'),
  });

  const uploadLogo = useMutation({
    mutationFn: ({ customerId, file }: { customerId: string; file: File }) => customersApi.uploadLogo(customerId, file),
    onSuccess: () => {
      refresh();
      notify({ title: 'Logo updated', detail: 'Documents generated for this account will carry it.' });
    },
    onError: fail('Could not upload logo'),
  });

  const removeChecklist = useMutation({
    mutationFn: customersApi.removeChecklist,
    onSuccess: () => {
      refresh();
      notify({ title: 'Checklist removed' });
    },
    onError: fail('Could not remove checklist'),
  });

  const removeTemplate = useMutation({
    mutationFn: customersApi.removeTemplate,
    onSuccess: () => {
      refresh();
      notify({ title: 'Template removed' });
    },
    onError: fail('Could not remove template'),
  });

  const uploadReference = useMutation({
    mutationFn: ({ customerId, file, kind, title }: { customerId: string; file: File; kind: CustomerReferenceKind; title?: string }) =>
      customersApi.uploadReference(customerId, file, kind, title),
    onSuccess: (reference) => {
      refresh();
      notify({
        title: `${reference.title} added`,
        detail: reference.textAvailable ? 'Text extracted and stored with it.' : 'Stored, but no readable text was found in it.',
      });
    },
    onError: fail('Could not upload the document'),
  });

  const removeReference = useMutation({
    mutationFn: customersApi.removeReference,
    onSuccess: () => {
      refresh();
      notify({ title: 'Document removed' });
    },
    onError: fail('Could not remove the document'),
  });

  const libraries = orderLibraries(library.data?.customers ?? []);
  const house = libraries.find(isHouseLibrary) ?? null;
  const selected = libraries.find((entry) => entry.id === params.get('lib')) ?? libraries[0] ?? null;
  const busy =
    uploadChecklist.isPending ||
    uploadTemplate.isPending ||
    uploadLogo.isPending ||
    uploadReference.isPending ||
    removeCustomer.isPending;

  return (
    <AccountShell crumb="ACCOUNT LIBRARIES" title="Library Center">
      <div className="page-head dash-head">
        <div>
          <h1 className="dash-title">
            <span>Account Libraries</span>
            <em>·</em>
            <b>Library Center</b>
          </h1>
          <p className="page-subline">Governance checklists, document templates and branding, reused by every project of that account</p>
        </div>
        <div className="dashboard-actions">
          {canWrite && (
            <button className="primary" onClick={() => setCreateOpen(true)}>
              + New Library
            </button>
          )}
        </div>
      </div>

      {/*
        The precedence, stated once: which library a project gets and how the two combine. A PM
        reading SKAX's templates needs to know they win over the FPT ones for the same document.
      */}
      <div className="lib-precedence">
        <span>
          <b className="lib-order">1</b>
          {house?.name ?? 'FPT Standard'} · mandatory baseline
        </span>
        <i>→</i>
        <span>
          <b className="lib-order">2</b>
          One account library · adds its checklist; its templates win for the same document
        </span>
      </div>

      {library.isLoading ? (
        <div className="state-block">
          <span className="inline-spinner" /> Loading the libraries…
        </div>
      ) : !libraries.length ? (
        <div className="state-block">
          No libraries yet. {canWrite ? 'Add one, then upload its checklist.' : 'A program owner can add the first one.'}
        </div>
      ) : (
        <>
          <div className="lib-grid">
            {libraries.map((entry) => (
              <LibraryCard key={entry.id} library={entry} selected={entry.id === selected?.id} onSelect={() => select(entry.id)} />
            ))}
          </div>

          {selected && (
            <LibraryPanel
              library={selected}
              canWrite={canWrite}
              busy={busy}
              tab={tab}
              onTab={setTab}
              onEdit={() => setEditCustomer(selected)}
              onUploadChecklist={(file) => uploadChecklist.mutate({ customerId: selected.id, file })}
              onUploadTemplate={(file, documentType) => uploadTemplate.mutate({ customerId: selected.id, file, documentType })}
              onUploadLogo={(file) => uploadLogo.mutate({ customerId: selected.id, file })}
              onRemoveChecklist={(id) => removeChecklist.mutate(id)}
              onRemoveTemplate={(id) => removeTemplate.mutate(id)}
              onPreviewChecklist={(id, name) => setPreviewChecklist({ id, name })}
              onUploadReference={(file, kind, title) => uploadReference.mutate({ customerId: selected.id, file, kind, title })}
              onRemoveReference={(id) => removeReference.mutate(id)}
            />
          )}
        </>
      )}

      <Backdrop open={createOpen} onClose={() => setCreateOpen(false)} />
      <NewCustomerModal
        open={createOpen}
        busy={createCustomer.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(body) => createCustomer.mutate(body)}
      />

      <Backdrop open={editCustomer !== null} onClose={() => setEditCustomer(null)} />
      <EditCustomerModal
        customer={editCustomer}
        busy={updateCustomer.isPending || removeCustomer.isPending}
        onClose={() => setEditCustomer(null)}
        onSubmit={(body) => editCustomer && updateCustomer.mutate({ customerId: editCustomer.id, body })}
        onDelete={() => editCustomer && removeCustomer.mutate(editCustomer.id)}
      />

      {previewChecklist && (
        <ChecklistPreview
          checklistId={previewChecklist.id}
          title={previewChecklist.name}
          onClose={() => setPreviewChecklist(null)}
        />
      )}
    </AccountShell>
  );
}

// ---------------------------------------------------------------------------

type LibraryTab = 'governance' | 'templates' | 'examples' | 'lessons';

/** "Other" in the document-type dropdown: the uploader types the document's name themself. */
const OTHER_TYPE = '__other';

const describe = (library: CustomerSummary) =>
  isHouseLibrary(library)
    ? 'System baseline applied to every project — its templates are the default for every document.'
    : library.aliases.length
      ? `Applied to projects whose customer matches ${library.aliases.join(', ')}.`
      : 'Applied only to projects whose customer is exactly this name.';

function LibraryCard({ library, selected, onSelect }: { library: CustomerSummary; selected: boolean; onSelect: () => void }) {
  const checklistItems = library.checklists.filter((checklist) => checklist.active).reduce((n, c) => n + c.itemCount, 0);
  const templates = library.templates.filter((template) => template.active).length;
  const house = isHouseLibrary(library);
  return (
    <button className="panel lib-card" aria-pressed={selected} onClick={onSelect}>
      <span className={`lib-chip ${house ? 'baseline' : 'account'}`}>{house ? 'Mandatory baseline' : 'Account library'}</span>
      <b>{library.name}</b>
      <p>{describe(library)}</p>
      <span className="lib-count">
        {checklistItems + templates}
        <small> items</small>
      </span>
      <small className="lib-split">
        {checklistItems} checklist item{checklistItems === 1 ? '' : 's'} · {templates} template{templates === 1 ? '' : 's'}
      </small>
    </button>
  );
}

function LibraryPanel({
  library,
  canWrite,
  busy,
  tab,
  onTab,
  onEdit,
  onUploadChecklist,
  onUploadTemplate,
  onUploadLogo,
  onRemoveChecklist,
  onRemoveTemplate,
  onPreviewChecklist,
  onUploadReference,
  onRemoveReference,
}: {
  library: CustomerSummary;
  canWrite: boolean;
  busy: boolean;
  tab: LibraryTab;
  onTab: (tab: LibraryTab) => void;
  onEdit: () => void;
  onUploadChecklist: (file: File) => void;
  onUploadTemplate: (file: File, documentType: string) => void;
  onUploadLogo: (file: File) => void;
  onRemoveChecklist: (id: string) => void;
  onRemoveTemplate: (id: string) => void;
  onPreviewChecklist: (id: string, name: string) => void;
  onUploadReference: (file: File, kind: CustomerReferenceKind, title?: string) => void;
  onRemoveReference: (id: string) => void;
}) {
  const checklistInput = useRef<HTMLInputElement>(null);
  const templateInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  /**
   * The template's document type is picked from the catalog, because a template reaches a document
   * only when the two names match — a free-text "Kick-off deck" would never be used. "Other" keeps
   * a way open for a document the catalog does not have yet.
   */
  const documentTypes = useQuery({ queryKey: ['document-types'], queryFn: customersApi.documentTypes, staleTime: 5 * 60_000 });
  const [typeChoice, setTypeChoice] = useState('');
  const [otherType, setOtherType] = useState('');
  const documentType = typeChoice === OTHER_TYPE ? otherType.trim() : typeChoice;
  const house = isHouseLibrary(library);
  const activeTemplates = library.templates.filter((template) => template.active).length;
  const examples = library.references.filter((reference) => reference.kind === 'APPROVED_EXAMPLE');
  const lessons = library.references.filter((reference) => reference.kind === 'LESSON_LEARNED');
  const tabs: { key: LibraryTab; label: string; count: number }[] = [
    { key: 'governance', label: 'Governance', count: library.checklists.filter((checklist) => checklist.active).length },
    { key: 'templates', label: 'Templates', count: activeTemplates },
    { key: 'examples', label: 'Approved Examples', count: examples.length },
    { key: 'lessons', label: 'Lessons Learned', count: lessons.length },
  ];

  return (
    <article className="panel lib-panel">
      <div className="panel-head">
        <div>
          <h2>{library.name}</h2>
          <p>{describe(library)}</p>
        </div>
        {canWrite && (
          <button className="secondary" disabled={busy} onClick={onEdit}>
            Edit name &amp; aliases
          </button>
        )}
      </div>

      {/* Matching and branding apply to the library as a whole, so they sit above the tabs. */}
      <div className="lib-meta">
        <div>
          <span className="lib-meta-label">Matches</span>
          <div className="customer-aliases">
            {library.aliases.length ? (
              library.aliases.map((alias) => <em key={alias}>{alias === '*' ? '* (every project)' : alias}</em>)
            ) : (
              <em className="muted">no aliases — only the exact name matches</em>
            )}
          </div>
        </div>
        <div className="lib-logo">
          <span className="lib-meta-label">Logo</span>
          {library.hasLogo ? (
            <img src={`/api/customers/logo/${library.id}/file`} alt={`${library.name} logo`} />
          ) : (
            <small className="customer-empty">No logo uploaded.</small>
          )}
          {canWrite && (
            <>
              <input
                ref={logoInput}
                type="file"
                hidden
                accept=".png,.jpg,.jpeg,.svg,.webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUploadLogo(file);
                  event.target.value = '';
                }}
              />
              <button className="secondary" disabled={busy} onClick={() => logoInput.current?.click()}>
                {library.hasLogo ? 'Replace logo' : 'Upload logo'}
              </button>
            </>
          )}
        </div>
      </div>

      <nav className="assessment-tabs lib-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            aria-selected={tab === entry.key}
            className={`assessment-tab${tab === entry.key ? ' active' : ''}`}
            onClick={() => onTab(entry.key)}
          >
            {entry.label} <span className="tab-count">{entry.count}</span>
          </button>
        ))}
      </nav>

      {tab === 'examples' || tab === 'lessons' ? (
        <ReferenceTab
          key={`${library.id}-${tab}`}
          kind={tab === 'examples' ? 'APPROVED_EXAMPLE' : 'LESSON_LEARNED'}
          library={library}
          references={tab === 'examples' ? examples : lessons}
          canWrite={canWrite}
          busy={busy}
          onUpload={onUploadReference}
          onRemove={onRemoveReference}
        />
      ) : tab === 'governance' ? (
        <section className="lib-tab-body">
          <p className="customer-hint">
            {house
              ? 'The checklist of the FPT house standard. Every project is also measured against the FPT Planning Assessment rules.'
              : `What ${library.name} requires of a project. Readiness is scored against the active version, beside the FPT standard.`}
          </p>
          {library.checklists.length ? (
            <ul className="customer-assets">
              {library.checklists.map((checklist) => (
                <li key={checklist.id} className={checklist.active ? 'active' : 'superseded'}>
                  <div>
                    <strong>
                      {checklist.name} <em>v{checklist.version}</em>
                      {!checklist.active && <span className="pill">superseded</span>}
                    </strong>
                    <small>{checklist.sourceFile}</small>
                    {checklist.parseNote && <small className="parse-note">{checklist.parseNote}</small>}
                  </div>
                  <div className="customer-asset-actions">
                    <b>{checklist.itemCount}</b>
                    <button className="secondary" onClick={() => onPreviewChecklist(checklist.id, checklist.name)}>
                      View items
                    </button>
                    <button className="secondary" onClick={() => customersApi.downloadChecklist(checklist.id, checklist.sourceFile)}>
                      Original
                    </button>
                    {canWrite && (
                      <button className="ghost danger" onClick={() => onRemoveChecklist(checklist.id)}>
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="customer-empty">No checklist uploaded.</p>
          )}
          {canWrite && (
            <>
              <input
                ref={checklistInput}
                type="file"
                hidden
                accept=".xlsx,.xlsm,.docx"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUploadChecklist(file);
                  event.target.value = '';
                }}
              />
              <button className="secondary" disabled={busy} onClick={() => checklistInput.current?.click()}>
                {library.checklists.length ? 'Upload a new version' : 'Upload checklist'} (.xlsx / .docx)
              </button>
            </>
          )}
        </section>
      ) : (
        <section className="lib-tab-body">
          <p className="customer-hint">
            {house
              ? 'The FPT template for each document, used whenever the project’s customer has none of its own. Where neither has one, the AI decides the structure.'
              : `${library.name}'s own template for a document. It takes precedence over the FPT one for ${library.name}'s projects.`}{' '}
            A template with [square-bracket] blanks is filled in place, keeping its layout, fonts and images; one without
            is followed as a structure. Either way the generated document downloads in the template's own format — Word,
            PowerPoint or Excel.
          </p>
          {library.templates.length ? (
            <ul className="customer-assets">
              {library.templates.map((template) => (
                <TemplateRow
                  key={template.id}
                  template={template}
                  canWrite={canWrite}
                  onRemove={() => onRemoveTemplate(template.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="customer-empty">
              {house
                ? 'No templates uploaded — generated documents use the neutral house style.'
                : 'No templates uploaded — projects of this account use the FPT Standard templates.'}
            </p>
          )}
          {canWrite && (
            <>
              <input
                ref={templateInput}
                type="file"
                hidden
                accept=".pptx,.docx,.xlsx"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onUploadTemplate(file, documentType);
                  event.target.value = '';
                }}
              />
              <div className="customer-template-add">
                <label className="lib-type-field">
                  <span>Template for</span>
                  <select value={typeChoice} onChange={(event) => setTypeChoice(event.target.value)}>
                    <option value="" disabled>
                      {documentTypes.isLoading ? 'Loading documents…' : 'Choose the document it is a template for'}
                    </option>
                    {(documentTypes.data?.documentTypes ?? []).map((entry) => (
                      <option key={entry.name} value={entry.name}>
                        {entry.name}
                        {entry.projectTypes.length < 3 ? ` (${entry.projectTypes.join(', ')})` : ''}
                      </option>
                    ))}
                    <option value={OTHER_TYPE}>Other — type the document name</option>
                  </select>
                </label>
                {typeChoice === OTHER_TYPE && (
                  <label className="lib-type-field">
                    <span>Document name</span>
                    <input
                      value={otherType}
                      onChange={(event) => setOtherType(event.target.value)}
                      placeholder="e.g. Service Transition Plan"
                    />
                  </label>
                )}
                <button className="secondary" disabled={busy || !documentType} onClick={() => templateInput.current?.click()}>
                  Upload template
                </button>
              </div>
              {typeChoice === OTHER_TYPE && (
                <small className="customer-hint">
                  A template is used for the document whose name matches it. A name no catalog document carries is
                  stored, but only a document of that exact name will follow it.
                </small>
              )}
            </>
          )}
        </section>
      )}
    </article>
  );
}

const REFERENCE_COPY: Record<CustomerReferenceKind, { what: string; empty: string; upload: string }> = {
  APPROVED_EXAMPLE: {
    what: 'Planning documents an earlier project of this account had approved — examples of what a good one looks like here.',
    empty: 'No approved examples uploaded yet.',
    upload: 'Upload approved example',
  },
  LESSON_LEARNED: {
    what: 'Lessons-learned records from earlier projects of this account.',
    empty: 'No lessons learned uploaded yet.',
    upload: 'Upload lessons learned',
  },
};

/**
 * The Approved Examples and Lessons Learned tabs. Documents are stored with their extracted text so
 * a later feature can use them; nothing reads them during generation yet, and the tab says so rather
 * than implying the AI already learns from them.
 */
function ReferenceTab({
  kind,
  library,
  references,
  canWrite,
  busy,
  onUpload,
  onRemove,
}: {
  kind: CustomerReferenceKind;
  library: CustomerSummary;
  references: CustomerReferenceSummary[];
  canWrite: boolean;
  busy: boolean;
  onUpload: (file: File, kind: CustomerReferenceKind, title?: string) => void;
  onRemove: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const copy = REFERENCE_COPY[kind];

  return (
    <section className="lib-tab-body">
      <p className="customer-hint">
        {copy.what} Stored in {library.name}'s library for future use — they are not yet read when documents are
        generated.
      </p>
      {references.length ? (
        <ul className="customer-assets">
          {references.map((reference) => (
            <li key={reference.id} className="active">
              <div>
                <strong>{reference.title}</strong>
                <small>
                  {reference.sourceFile} · {formatSize(reference.sizeBytes)} · {new Date(reference.uploadedAt).toLocaleDateString()}
                </small>
                {!reference.textAvailable && <small className="parse-note">No readable text was found in this file.</small>}
              </div>
              <div className="customer-asset-actions">
                <button className="secondary" onClick={() => customersApi.downloadReference(reference.id, reference.sourceFile)}>
                  Original
                </button>
                {canWrite && (
                  <button
                    className="ghost danger"
                    onClick={() => {
                      if (window.confirm(`Remove "${reference.title}" from ${library.name}'s library?`)) onRemove(reference.id);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="customer-empty">{copy.empty}</p>
      )}
      {canWrite && (
        <>
          <input
            ref={input}
            type="file"
            hidden
            accept=".docx,.xlsx,.xlsm,.pptx,.pdf,.txt,.md"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onUpload(file, kind, title.trim() || undefined);
              setTitle('');
              event.target.value = '';
            }}
          />
          <div className="customer-template-add">
            <label className="lib-type-field">
              <span>Title (optional)</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Defaults to the file name" />
            </label>
            <button className="secondary" disabled={busy} onClick={() => input.current?.click()}>
              {copy.upload}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function TemplateRow({
  template,
  canWrite,
  onRemove,
}: {
  template: CustomerTemplateSummary;
  canWrite: boolean;
  onRemove: () => void;
}) {
  const [showTokens, setShowTokens] = useState(false);
  const split = template.placeholders.filter((placeholder) => placeholder.splitAcrossRuns);

  return (
    <li className={template.active ? 'active' : 'superseded'}>
      <div>
        <strong>
          {template.documentType} <em>v{template.version}</em> <span className="pill">{template.fileType}</span>
          {!template.active && <span className="pill">superseded</span>}
        </strong>
        <small>{template.sourceFile}</small>
        {template.parseNote && <small className="parse-note">{template.parseNote}</small>}
        {showTokens && (
          <ul className="placeholder-list">
            {template.placeholders.map((placeholder) => (
              <li key={placeholder.token}>
                <code>{placeholder.token}</code>
                <span>
                  ×{placeholder.occurrences} · {placeholder.locations.join(', ')}
                </span>
                {placeholder.splitAcrossRuns && <b title="Needs run merging before substitution">split</b>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="customer-asset-actions">
        <b>{template.placeholderCount}</b>
        <button className="secondary" onClick={() => setShowTokens(!showTokens)}>
          {showTokens ? 'Hide' : 'Placeholders'}
          {split.length ? ` (${split.length}⚠)` : ''}
        </button>
        <button
          className="secondary"
          onClick={() => customersApi.downloadTemplate(template.id, template.sourceFile)}
        >
          Original
        </button>
        {canWrite && (
          <button className="ghost danger" onClick={onRemove}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

function NewCustomerModal({
  open,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; key?: string; aliases: string[] }) => void;
}) {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');

  return (
    <ModalShell open={open} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>NEW LIBRARY</small>
          <h2>Add an account library</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name: name.trim(),
            aliases: aliases
              .split(',')
              .map((alias) => alias.trim())
              .filter(Boolean),
          });
        }}
      >
        <label>
          Account name *
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            minLength={2}
            placeholder="SK AX"
          />
        </label>
        <label>
          Aliases
          <input
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder="SKAX, SK C&amp;C, AGS"
          />
        </label>
        <div className="create-note">
          <span>🔎</span>
          <p>
            Comma-separated. A project's Customer field is free text — nobody should have to wait for a dropdown option
            before starting a project — so these aliases are what match a project to this library entry.
            <br />
            <b>SK C&amp;C</b> matches that exact name. <b>SK*</b> matches any customer name <i>starting with</i> SK —
            one rule for a whole group. <b>*</b> makes this customer the house default, used when nothing else matches.
          </p>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || name.trim().length < 2}>
            {busy ? 'Adding…' : 'Add library'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

/**
 * Editing a customer's name and aliases.
 *
 * The aliases are the whole point of this dialog: they are what match a project's free-text
 * Customer field to this library entry, and getting them wrong is silent — the project simply
 * falls through to the house default and gets the wrong checklist and the wrong kickoff template,
 * with no error anywhere. So the rules are restated here rather than only on the create dialog,
 * where whoever is fixing a bad match is unlikely to look.
 *
 * `key` is deliberately not editable: code and stored rows refer to it, and a customer whose key
 * changed under them would break the reference rather than rename it.
 */
function EditCustomerModal({
  customer,
  busy,
  onClose,
  onSubmit,
  onDelete,
}: {
  customer: CustomerSummary | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; aliases: string[] }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');

  useEffect(() => {
    setName(customer?.name ?? '');
    setAliases((customer?.aliases ?? []).join(', '));
  }, [customer]);

  return (
    <ModalShell open={customer !== null} className="create-project-modal structure-modal">
      <div className="modal-head">
        <div>
          <small>EDIT LIBRARY · {customer?.key}</small>
          <h2>{customer?.name}</h2>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name: name.trim(),
            aliases: aliases
              .split(',')
              .map((alias) => alias.trim())
              .filter(Boolean),
          });
        }}
      >
        <label>
          Account name *
          <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
        </label>
        <label>
          Aliases
          <input
            value={aliases}
            onChange={(event) => setAliases(event.target.value)}
            placeholder="SKAX, SK C&amp;C, SK*"
          />
        </label>
        <div className="create-note">
          <span>🔎</span>
          <p>
            Comma-separated, and this is what decides which projects belong to this customer.
            <br />
            <b>SK C&amp;C</b> matches that exact name. <b>SK*</b> matches any customer name <i>starting with</i> SK —
            one rule for a whole group; the longest matching prefix wins. <b>*</b> makes this customer the house
            default, used only when nothing else matched.
          </p>
        </div>
        <div className="modal-actions">
          {/*
            Deleting sits in the edit dialog rather than on the card: it takes the checklists,
            their parsed items, the templates and the stored files with it, so it should need one
            deliberate step more than a click in a list.
          */}
          <button
            type="button"
            className="secondary danger"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${customer?.name}? Its checklists, their parsed items, its templates and logo are removed with it. Projects keep their Customer field but will stop matching.`,
                )
              ) {
                onDelete();
              }
            }}
          >
            Delete library
          </button>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || name.trim().length < 2}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
