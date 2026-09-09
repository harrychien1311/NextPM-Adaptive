import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardExportApi, documentsApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import type { CatalogEntry, ManagementDomain } from '../../api/types';

const DOMAIN_TABS: { domain: ManagementDomain; label: string; glyph: string; tone: string }[] = [
  { domain: 'GOVERNANCE', label: 'Governance', glyph: 'G', tone: 'navy' },
  { domain: 'SCOPE', label: 'Scope', glyph: 'S', tone: 'cyan' },
  { domain: 'SCHEDULE', label: 'Schedule', glyph: 'T', tone: 'violet' },
  { domain: 'FINANCE', label: 'Finance', glyph: 'F', tone: 'green-bg' },
  { domain: 'STAKEHOLDERS', label: 'Stakeholders', glyph: 'H', tone: 'orange' },
  { domain: 'RESOURCES', label: 'Resources', glyph: 'R', tone: 'rose' },
  { domain: 'RISK', label: 'Risk', glyph: '!', tone: 'red-bg' },
];

interface SectionDraft {
  title: string;
  hint?: string;
  required: boolean;
  included: boolean;
  custom: boolean;
}

export function StudioView({ projectId }: { projectId: string }) {
  const notify = useToast();
  const queryClient = useQueryClient();

  const [domain, setDomain] = useState<ManagementDomain>('GOVERNANCE');
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [sections, setSections] = useState<SectionDraft[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['studio', projectId],
    queryFn: () => documentsApi.studio(projectId),
  });

  const domainDocs = useMemo(
    () => (data?.catalog ?? []).filter((entry) => entry.domain === domain),
    [data, domain],
  );
  const selected: CatalogEntry | undefined =
    domainDocs.find((entry) => entry.definitionId === definitionId) ?? domainDocs[0];

  const fit = useQuery({
    queryKey: ['fit', projectId, selected?.definitionId],
    queryFn: () => documentsApi.fit(projectId, selected!.definitionId) as Promise<{
      fitScore: number;
      reasons: string[];
      controls: { projectType: string; approach: string | null; rigor: string | null };
      disclaimer: string;
    }>,
    enabled: Boolean(selected),
  });

  // Load the current contract (or the recommended template's structure) when the document changes.
  useEffect(() => {
    if (!selected) return;
    const activeTemplate =
      selected.templates.find((template) => template.id === selected.document?.templateId) ??
      selected.templates.find((template) => template.recommended) ??
      selected.templates[0];
    setTemplateId(activeTemplate?.id ?? null);
    setSections(
      selected.document?.sections.length
        ? selected.document.sections.map((section) => ({
            title: section.title,
            hint: section.hint ?? undefined,
            required: section.required,
            included: section.included,
            custom: section.custom,
          }))
        : (activeTemplate?.sections ?? []).map((section) => ({
            title: section.title,
            hint: section.hint,
            required: Boolean(section.required),
            included: section.defaultIncluded !== false,
            custom: false,
          })),
    );
  }, [selected?.definitionId, selected?.document?.id]);

  const chooseTemplate = (id: string) => {
    setTemplateId(id);
    const template = selected?.templates.find((item) => item.id === id);
    setSections(
      (template?.sections ?? []).map((section) => ({
        title: section.title,
        hint: section.hint,
        required: Boolean(section.required),
        included: section.defaultIncluded !== false,
        custom: false,
      })),
    );
    notify({ title: `${template?.name} template selected`, detail: 'You can modify its structure before generation.' });
  };

  const generate = useMutation({
    mutationFn: async () => {
      const document = (await documentsApi.setContract(projectId, {
        definitionId: selected!.definitionId,
        templateId: templateId!,
        sections,
      })) as { id: string };
      return documentsApi.generate(projectId, document.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      notify({
        title: 'Planning draft generated',
        detail: 'AI produced the content; PM review and confirmation are still required.',
      });
    },
    onError: (error) => notify({ title: 'Generation blocked', detail: (error as Error).message }),
  });

  const approve = useMutation({
    mutationFn: (documentId: string) => documentsApi.approve(projectId, documentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['studio', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      notify({ title: 'Document confirmed', detail: 'This version can now enter the approved planning baseline.' });
    },
  });

  const exportPack = useMutation({
    mutationFn: () => documentsApi.export(projectId, 'DOCX'),
    onSuccess: () =>
      notify({
        title: 'Approved baseline prepared',
        detail: 'Drafts, TBD values and unconfirmed AI content were excluded.',
      }),
    onError: (error) => notify({ title: 'Export not possible', detail: (error as Error).message }),
  });

  if (isLoading || !data) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading the document catalog…
        </div>
      </section>
    );
  }

  const generated = data.catalog.filter((entry) => entry.document && entry.document.status !== 'NOT_GENERATED').length;
  const approved = data.catalog.filter((entry) => entry.document?.status === 'APPROVED').length;
  const draft = selected?.document;
  const includedCount = sections.filter((section) => section.included).length;

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PLANNING FLOW 3 · TEMPLATE, GENERATE &amp; APPROVE</p>
          <h1>Choose the structure before AI writes the content.</h1>
          <span>
            Select a management domain and document. Compare three PMBOK-aligned product templates, customize sections,
            then generate the draft.
          </span>
        </div>
        <div className="evidence-stats">
          <div>
            <strong>
              {generated}/{data.catalog.length}
            </strong>
            <span>generated</span>
          </div>
          <div>
            <strong>
              {approved}/{data.catalog.length}
            </strong>
            <span>PM approved</span>
          </div>
        </div>
      </div>

      <div className="generation-banner">
        <span>✦</span>
        <div>
          <strong>
            {fit.data?.controls.projectType ?? ''} · {fit.data?.controls.approach ?? 'Governance model pending'} Planning Pack
          </strong>
          <p>
            The six governance artifacts (Project Charter, Organization Chart, RACI Matrix, Communication Plan,
            Change / Escalation Flow, Risk Plan) are required for every project; their structure follows the
            confirmed governance model.
          </p>
        </div>
        <span className="rule-version">{fit.data?.controls.rigor ?? '—'}</span>
      </div>

      <div className="domain-tabs">
        {DOMAIN_TABS.map((tab) => (
          <button
            key={tab.domain}
            className={domain === tab.domain ? 'active' : ''}
            onClick={() => {
              setDomain(tab.domain);
              setDefinitionId(null);
            }}
          >
            <span className={`domain-glyph ${tab.tone}`}>{tab.glyph}</span>
            {tab.label} <b>{data.domains.find((row) => row.domain === tab.domain)?.count ?? 0}</b>
          </button>
        ))}
      </div>

      <div className="template-workspace">
        <aside className="panel document-catalog">
          <div className="catalog-head">
            <div>
              <h2>{DOMAIN_TABS.find((tab) => tab.domain === domain)?.label} documents</h2>
              <p>Recommended for this project</p>
            </div>
            <button>＋</button>
          </div>
          <div>
            {domainDocs.map((entry) => (
              <button
                key={entry.definitionId}
                className={`catalog-item${selected?.definitionId === entry.definitionId ? ' active' : ''}`}
                onClick={() => setDefinitionId(entry.definitionId)}
              >
                <span>
                  <b>{entry.name}</b>
                  <small>
                    {entry.requirement === 'REQUIRED' ? 'Required' : 'Conditional'} ·{' '}
                    {entry.document ? statusLabel(entry.document.status) : 'Not generated'}
                  </small>
                </span>
                <i>›</i>
              </button>
            ))}
          </div>
          <div className="catalog-note">
            <span>◇</span>
            <p>Conditional documents appear only when matching project rules are triggered.</p>
          </div>
        </aside>

        <main className="template-main">
          <div className="template-heading">
            <div>
              <span className="doc-kicker">
                {domain} · {selected?.requirement}
              </span>
              <h2>{selected?.name}</h2>
              <p>Choose the initial structure. You can add, remove or reorder sections before generation.</p>
            </div>
            <span className="template-source-note">PMBOK-aligned product templates</span>
          </div>

          <div className="template-options">
            {(selected?.templates ?? []).map((template) => (
              <article
                key={template.id}
                className={`template-card${templateId === template.id ? ' selected' : ''}`}
                onClick={() => chooseTemplate(template.id)}
              >
                <div className="template-card-top">
                  <span className={`template-icon ${template.key}-icon`}>{template.name[0]}</span>
                  <div>
                    <strong>{template.name}</strong>
                    <small>{template.subtitle}</small>
                  </div>
                  {template.recommended && <i>RECOMMENDED</i>}
                </div>
                <p>{template.description}</p>
                <ul>
                  {template.sections.slice(0, 5).map((section) => (
                    <li key={section.title}>{section.title}</li>
                  ))}
                </ul>
                <button>{templateId === template.id ? '✓ Selected' : 'Select template'}</button>
              </article>
            ))}
          </div>

          <section className="panel structure-editor">
            <div className="structure-head">
              <div>
                <h3>Customize template structure</h3>
                <p>Checked sections become the generation contract.</p>
              </div>
              <div>
                <button
                  className="secondary"
                  onClick={() => templateId && chooseTemplate(templateId)}
                >
                  Reset
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    const title = window.prompt('Section title', 'New PM-defined section');
                    if (title) setSections((current) => [...current, { title, required: false, included: true, custom: true }]);
                  }}
                >
                  + Custom section
                </button>
              </div>
            </div>
            <div className="section-builder">
              {sections.map((section, index) => (
                <label key={`${section.title}-${index}`}>
                  <span className="drag">⋮⋮</span>
                  <input
                    type="checkbox"
                    checked={section.included}
                    onChange={(event) =>
                      setSections((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, included: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  <div>
                    <strong>{section.title}</strong>
                    <small>{section.hint ?? (section.custom ? 'PM-defined section' : 'Generated from verified project inputs')}</small>
                  </div>
                  {section.required ? <b>Required</b> : <em>Optional</em>}
                </label>
              ))}
            </div>
            <div className="structure-footer">
              <div>
                <span>Template coverage</span>
                <strong>{Math.round((includedCount / Math.max(sections.length, 1)) * 100)}%</strong>
                <small>{includedCount} sections in the generation contract</small>
              </div>
              <button
                className="primary"
                onClick={() => generate.mutate()}
                disabled={generate.isPending || !templateId || includedCount === 0}
              >
                {generate.isPending ? '✦ Generating from confirmed inputs…' : '✦ Generate draft from this structure'}
              </button>
            </div>
          </section>

          {draft && draft.status !== 'NOT_GENERATED' && (
            <section className="panel generated-preview">
              <div className="editor-head">
                <div>
                  <span className="doc-kicker">
                    {draft.status === 'APPROVED' ? 'PM APPROVED · BASELINE' : 'AI DRAFT · PM REVIEW REQUIRED'}
                  </span>
                  <h2>
                    {selected?.name} — v{draft.version}
                  </h2>
                </div>
                <div>
                  <button className="secondary">Edit content</button>
                  <button
                    className="secondary"
                    onClick={() => documentsApi.downloadDocx(projectId, draft.id, selected?.name ?? 'document')}
                  >
                    Download .docx
                  </button>
                  <button
                    className="primary"
                    disabled={draft.status === 'APPROVED' || approve.isPending}
                    onClick={() => approve.mutate(draft.id)}
                  >
                    {draft.status === 'APPROVED' ? '✓ Confirmed by PM' : '✓ PM approve'}
                  </button>
                </div>
              </div>
              <div className="source-strip">
                <span>✦</span>
                <p>
                  <strong>Generated from:</strong> verified inputs, selected template structure and confirmed project
                  rules.
                </p>
                <button>View source trace</button>
              </div>
              <div className="editor-body">
                {draft.sections
                  .filter((section) => section.included && section.content)
                  .map((section) => (
                    <div key={section.id}>
                      <h3>{section.title}</h3>
                      <p>{section.content}</p>
                    </div>
                  ))}
                {draft.pmQuestions.map((question) => (
                  <div className="pm-question" key={question}>
                    <span>?</span>
                    <div>
                      <strong>PM confirmation needed</strong>
                      <p>{question}</p>
                    </div>
                    <button>Answer</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </main>

        <aside className="panel template-inspector">
          <span className="ai-label">TEMPLATE FIT</span>
          <div className="fit-score">
            <strong>{fit.data?.fitScore ?? '—'}%</strong>
            <span>for this {fit.data?.controls.projectType} project</span>
          </div>
          <h3>Why recommended</h3>
          <ul>
            {(fit.data?.reasons ?? []).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <hr />
          <h3>Template controls</h3>
          <div>
            <span>Project type</span>
            <strong>{fit.data?.controls.projectType}</strong>
          </div>
          <div>
            <span>Approach</span>
            <strong>{fit.data?.controls.approach ?? '—'}</strong>
          </div>
          <div>
            <span>Rigor</span>
            <strong>{fit.data?.controls.rigor ?? '—'}</strong>
          </div>
          <p className="template-disclaimer">{fit.data?.disclaimer}</p>
        </aside>
      </div>

      <div className="export-bar">
        <div>
          <span>▣</span>
          <div>
            <strong>Export Project Initiation &amp; Planning Pack</strong>
            <p>Approved workspace pages only · Confluence, DOCX, XLSX or PDF</p>
          </div>
        </div>
        <div>
          <button className="secondary" onClick={() => dashboardExportApi.downloadHtml(projectId)}>
            Download dashboard (.html)
          </button>
          <button className="primary" onClick={() => exportPack.mutate()} disabled={exportPack.isPending}>
            {exportPack.isPending ? 'Preparing…' : 'Export approved baseline'}
          </button>
        </div>
      </div>
    </section>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case 'APPROVED':
      return 'PM approved';
    case 'PM_REVIEW':
      return 'PM review';
    case 'GENERATING':
      return 'Generating';
    default:
      return 'Not generated';
  }
}
