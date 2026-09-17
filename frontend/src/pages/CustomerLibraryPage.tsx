import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints';
import type { CustomerSummary, CustomerTemplateSummary } from '../api/types';
import { useAuth } from '../store/auth';
import { useToast } from '../components/Toast';
import { Backdrop, ModalShell } from '../components/Modal';
import { SignOutIcon } from '../components/icons';
import { ApiError } from '../api/client';
import { ChecklistPreview } from './ChecklistPreview';

/**
 * The customer reference library.
 *
 * Its whole reason to exist is that a checklist belongs to a *customer*, not to a project: LGCNS's
 * intake checklist and SKAX's operational readiness checklist are uploaded here once and every
 * project for that customer is assessed against them, instead of the PM re-uploading the same file
 * into each new workspace.
 *
 * A project finds its customer by matching what the PM typed into the project's free-text Customer
 * field against the aliases below. The field is free text on purpose — a new customer must not
 * have to wait for someone to add a dropdown option — so the aliases are what make "SK AX",
 * "SK C&C" and "AGS" land on the same library entry.
 *
 * Parsing is shown, never hidden: every checklist reports what the parser read, and the original
 * file stays downloadable so the numbers can be checked against it.
 */
export function CustomerLibraryPage() {
  const { user, logout } = useAuth();
  const notify = useToast();
  const queryClient = useQueryClient();

  const library = useQuery({ queryKey: ['customers'], queryFn: customersApi.list });

  const [createOpen, setCreateOpen] = useState(false);
  const [previewChecklist, setPreviewChecklist] = useState<{ id: string; name: string } | null>(null);
  const [openCustomer, setOpenCustomer] = useState<string | null>(null);

  const canWrite = user?.role === 'PROGRAM_OWNER' || user?.role === 'ADMIN';

  const fail = (title: string) => (error: unknown) =>
    notify({ title, detail: error instanceof ApiError ? error.message : 'Unexpected error' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['customers'] });

  const createCustomer = useMutation({
    mutationFn: customersApi.create,
    onSuccess: (customer) => {
      refresh();
      setCreateOpen(false);
      setOpenCustomer(customer.id);
      notify({ title: `${customer.name} added`, detail: 'Now upload their checklist and templates.' });
    },
    onError: fail('Could not add customer'),
  });

  const removeCustomer = useMutation({
    mutationFn: customersApi.remove,
    onSuccess: () => {
      refresh();
      notify({ title: 'Customer removed' });
    },
    onError: fail('Could not remove customer'),
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
    mutationFn: ({ customerId, file }: { customerId: string; file: File }) =>
      customersApi.uploadLogo(customerId, file),
    onSuccess: () => {
      refresh();
      notify({ title: 'Logo updated', detail: 'Documents generated for this customer will carry it.' });
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

  if (library.isLoading) {
    return (
      <div className="state-block">
        <span className="inline-spinner" /> Loading the customer library…
      </div>
    );
  }

  const customers = library.data?.customers ?? [];
  const totalItems = customers.reduce(
    (sum, customer) => sum + customer.checklists.filter((c) => c.active).reduce((n, c) => n + c.itemCount, 0),
    0,
  );
  const totalTemplates = customers.reduce((sum, customer) => sum + customer.templates.filter((t) => t.active).length, 0);

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
            <span>REFERENCE LIBRARY</span>
            <b>Customers</b>
          </div>
          <div className="portfolio-profile">
            <div className="avatar">{user?.initials}</div>
            <div>
              <strong>{user?.name}</strong>
              <span>{canWrite ? 'May edit the library' : 'Read only'}</span>
            </div>
            {/* Last child, so sign out is the top-right corner — the same place on every screen. */}
            <button className="icon-button signout-button" onClick={logout} title="Sign out" aria-label="Sign out">
              <SignOutIcon />
            </button>
          </div>
        </header>

        <main className="portfolio-main">
          <div className="portfolio-title">
            <div>
              <p>CUSTOMER REFERENCE DATA</p>
              <h1>Checklists and templates, per customer</h1>
              <span>
                Uploaded once and reused by every project for that customer — nobody re-uploads the same checklist into
                a new workspace. A project is matched to a customer by the name the PM typed into its Customer field:
                list the spellings they might use, or one rule — <b>SK*</b> claims every name starting with SK, and{' '}
                <b>*</b> marks the house default for everything nothing else recognised.
              </span>
            </div>
            <div className="portfolio-create-actions">
              {user?.role !== 'ADMIN' && (
                <Link className="secondary button-link" to="/">
                  ← Programs
                </Link>
              )}
              {canWrite && (
                <button className="primary" onClick={() => setCreateOpen(true)}>
                  + New customer
                </button>
              )}
            </div>
          </div>

          <div className="portfolio-summary">
            <article>
              <span>CUSTOMERS</span>
              <strong>{customers.length}</strong>
              <small>{customers.filter((c) => c.active).length} active</small>
            </article>
            <article>
              <span>CHECKLIST ITEMS</span>
              <strong>{totalItems}</strong>
              <small>Across all active checklists</small>
            </article>
            <article>
              <span>DOCUMENT TEMPLATES</span>
              <strong>{totalTemplates}</strong>
              <small>Filled in place, layout preserved</small>
            </article>
            <article>
              <span>LOGOS</span>
              <strong>{customers.filter((c) => c.hasLogo).length}</strong>
              <small>Carried onto generated documents</small>
            </article>
          </div>

          {!customers.length && (
            <div className="state-block">
              No customers yet.{' '}
              {canWrite ? 'Add one, then upload their checklist.' : 'A program owner can add the first one.'}
            </div>
          )}

          <div className="customer-list">
            {customers.map((customer) => (
              <CustomerCard
                key={customer.id}
                customer={customer}
                canWrite={canWrite}
                open={openCustomer === customer.id}
                onToggle={() => setOpenCustomer(openCustomer === customer.id ? null : customer.id)}
                busy={
                  uploadChecklist.isPending ||
                  uploadTemplate.isPending ||
                  uploadLogo.isPending ||
                  removeCustomer.isPending
                }
                onUploadChecklist={(file) => uploadChecklist.mutate({ customerId: customer.id, file })}
                onUploadTemplate={(file, documentType) =>
                  uploadTemplate.mutate({ customerId: customer.id, file, documentType })
                }
                onUploadLogo={(file) => uploadLogo.mutate({ customerId: customer.id, file })}
                onRemove={() => removeCustomer.mutate(customer.id)}
                onRemoveChecklist={(id) => removeChecklist.mutate(id)}
                onRemoveTemplate={(id) => removeTemplate.mutate(id)}
                onPreviewChecklist={(id, name) => setPreviewChecklist({ id, name })}
              />
            ))}
          </div>
        </main>
      </section>

      <Backdrop open={createOpen} onClose={() => setCreateOpen(false)} />
      <NewCustomerModal
        open={createOpen}
        busy={createCustomer.isPending}
        onClose={() => setCreateOpen(false)}
        onSubmit={(body) => createCustomer.mutate(body)}
      />

      {previewChecklist && (
        <ChecklistPreview
          checklistId={previewChecklist.id}
          title={previewChecklist.name}
          onClose={() => setPreviewChecklist(null)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

function CustomerCard({
  customer,
  canWrite,
  open,
  busy,
  onToggle,
  onUploadChecklist,
  onUploadTemplate,
  onUploadLogo,
  onRemove,
  onRemoveChecklist,
  onRemoveTemplate,
  onPreviewChecklist,
}: {
  customer: CustomerSummary;
  canWrite: boolean;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onUploadChecklist: (file: File) => void;
  onUploadTemplate: (file: File, documentType: string) => void;
  onUploadLogo: (file: File) => void;
  onRemove: () => void;
  onRemoveChecklist: (id: string) => void;
  onRemoveTemplate: (id: string) => void;
  onPreviewChecklist: (id: string, name: string) => void;
}) {
  const checklistInput = useRef<HTMLInputElement>(null);
  const templateInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const [documentType, setDocumentType] = useState('Kickoff Deck');

  const activeChecklist = customer.checklists.find((checklist) => checklist.active);
  const activeTemplates = customer.templates.filter((template) => template.active);

  return (
    <article className={`customer-card${open ? ' open' : ''}`}>
      <header onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
        <div className="customer-identity">
          <div className="customer-key">{customer.key}</div>
          <div>
            <strong>{customer.name}</strong>
            <span>
              {activeChecklist ? `${activeChecklist.itemCount} checklist items` : 'no checklist yet'}
              {' · '}
              {activeTemplates.length} template{activeTemplates.length === 1 ? '' : 's'}
              {customer.hasLogo ? ' · logo' : ''}
            </span>
          </div>
        </div>
        <div className="customer-aliases">
          {customer.aliases.length ? (
            customer.aliases.map((alias) => <em key={alias}>{alias}</em>)
          ) : (
            <em className="muted">no aliases — only the exact name matches</em>
          )}
        </div>
        <span className="customer-chevron">{open ? '▴' : '▾'}</span>
      </header>

      {open && (
        <div className="customer-body">
          <section>
            <h4>Checklist</h4>
            <p className="customer-hint">
              What this customer requires of a project. Readiness will be scored against the active version.
            </p>
            {customer.checklists.length ? (
              <ul className="customer-assets">
                {customer.checklists.map((checklist) => (
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
                      <button
                        className="secondary"
                        onClick={() => customersApi.downloadChecklist(checklist.id, checklist.sourceFile)}
                      >
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
                  {customer.checklists.length ? 'Upload a new version' : 'Upload checklist'} (.xlsx / .docx)
                </button>
              </>
            )}
          </section>

          <section>
            <h4>Document templates</h4>
            <p className="customer-hint">
              The customer's own file for a document type. Generation fills it in place, so their layout, fonts and
              images survive.
            </p>
            {customer.templates.length ? (
              <ul className="customer-assets">
                {customer.templates.map((template) => (
                  <TemplateRow
                    key={template.id}
                    template={template}
                    canWrite={canWrite}
                    onRemove={() => onRemoveTemplate(template.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="customer-empty">No templates uploaded — generated documents use the neutral house style.</p>
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
                  <input
                    value={documentType}
                    onChange={(event) => setDocumentType(event.target.value)}
                    placeholder="Document type, e.g. Kickoff Deck"
                  />
                  <button
                    className="secondary"
                    disabled={busy || !documentType.trim()}
                    onClick={() => templateInput.current?.click()}
                  >
                    Upload template
                  </button>
                </div>
              </>
            )}
          </section>

          <section>
            <h4>Logo</h4>
            <p className="customer-hint">Carried onto documents generated for this customer.</p>
            <div className="customer-logo-row">
              {customer.hasLogo ? (
                <img src={`/api/customers/logo/${customer.id}/file`} alt={`${customer.name} logo`} />
              ) : (
                <p className="customer-empty">No logo uploaded.</p>
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
                    {customer.hasLogo ? 'Replace logo' : 'Upload logo'}
                  </button>
                </>
              )}
            </div>
          </section>

          {canWrite && (
            <footer className="customer-danger">
              <button className="ghost danger" disabled={busy} onClick={onRemove}>
                Remove {customer.name} and everything in it
              </button>
            </footer>
          )}
        </div>
      )}
    </article>
  );
}

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
          <small>NEW CUSTOMER</small>
          <h2>Add a customer to the library</h2>
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
          Customer name *
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
            {busy ? 'Adding…' : 'Add customer'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
