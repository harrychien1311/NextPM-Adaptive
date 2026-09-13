import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardExportApi, documentsApi, projectApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { DocumentPreview } from './DocumentPreview';
import { ApiError } from '../../api/client';
import type { CatalogEntry, DocumentGap, ManagementDomain } from '../../api/types';

const DOMAIN_TABS: { domain: ManagementDomain; label: string; glyph: string; tone: string }[] = [
  { domain: 'GOVERNANCE', label: 'Governance', glyph: 'G', tone: 'navy' },
  { domain: 'SCOPE', label: 'Scope', glyph: 'S', tone: 'cyan' },
  { domain: 'SCHEDULE', label: 'Schedule', glyph: 'T', tone: 'violet' },
  { domain: 'FINANCE', label: 'Finance', glyph: 'F', tone: 'green-bg' },
  { domain: 'STAKEHOLDERS', label: 'Stakeholders', glyph: 'H', tone: 'orange' },
  { domain: 'RESOURCES', label: 'Resources', glyph: 'R', tone: 'rose' },
  { domain: 'RISK', label: 'Risk', glyph: '!', tone: 'red-bg' },
];

/** Capturing + global so `split` keeps the tokens as their own array entries. */
const GAP_SPLIT = /(\{\{gap:\d+\}\})/g;
/** A separate, non-global copy: `.test()` on a /g regex advances lastIndex between calls. */
const IS_GAP = /^\{\{gap:\d+\}\}$/;

/** Renders a blank the model left as a visible marker instead of leaking the raw token. */
function SectionText({ content }: { content: string }) {
  return (
    <p>
      {content.split(GAP_SPLIT).map((part, index) =>
        IS_GAP.test(part) ? (
          <mark className="gap-marker" key={index} title="Answer this on the right, then press Fill out the document">
            answer needed
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </p>
  );
}

export function StudioView({ projectId }: { projectId: string }) {
  const notify = useToast();
  const queryClient = useQueryClient();

  const [domain, setDomain] = useState<ManagementDomain>('GOVERNANCE');
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editSections, setEditSections] = useState<{ title: string; content: string }[]>([]);
  const [answering, setAnswering] = useState<DocumentGap | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['studio', projectId],
    queryFn: () => documentsApi.studio(projectId),
  });

  // Same cache entry WorkspacePage already populated — only needed for the preview's title block.
  const workspace = useQuery({
    queryKey: ['workspace', projectId],
    queryFn: () => projectApi.workspace(projectId),
  });

  const domainDocs = useMemo(
    () => (data?.catalog ?? []).filter((entry) => entry.domain === domain),
    [data, domain],
  );
  const selected: CatalogEntry | undefined =
    domainDocs.find((entry) => entry.definitionId === definitionId) ?? domainDocs[0];
  const draft = selected?.document;

  const fit = useQuery({
    queryKey: ['fit', projectId, selected?.definitionId],
    queryFn: () => documentsApi.fit(projectId, selected!.definitionId) as Promise<{
      controls: { projectType: string; approach: string | null; rigor: string | null };
    }>,
    enabled: Boolean(selected),
  });

  // Leave edit/preview mode whenever a different document is opened.
  useEffect(() => {
    setEditing(false);
    setPreviewing(false);
  }, [selected?.definitionId]);

  // Escape closes the full-screen preview, and the page behind it must not scroll under it.
  useEffect(() => {
    if (!previewing) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setPreviewing(false);
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [previewing]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['studio', projectId] });
    queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
  };
  const fail = (title: string) => (error: unknown) =>
    notify({ title, detail: error instanceof ApiError ? error.message : (error as Error).message });

  const generate = useMutation({
    mutationFn: () => documentsApi.generate(projectId, selected!.definitionId),
    onSuccess: () => {
      refresh();
      notify({
        title: 'Document generated',
        detail: 'The AI chose the structure and left every unknown fact blank for you to confirm.',
      });
    },
    onError: fail('Generation blocked'),
  });

  const saveContent = useMutation({
    mutationFn: () => documentsApi.saveSections(projectId, draft!.id, editSections),
    onSuccess: () => {
      refresh();
      setEditing(false);
      notify({ title: 'Document saved', detail: 'Your edits replaced the draft content.' });
    },
    onError: fail('Could not save'),
  });

  const answerGap = useMutation({
    mutationFn: ({ token, answer }: { token: string; answer: string }) =>
      documentsApi.answerGap(projectId, draft!.id, token, answer),
    onSuccess: () => {
      refresh();
      setAnswering(null);
      notify({ title: 'Answer recorded', detail: 'Press "Fill out the document" to write it in.' });
    },
    onError: fail('Could not record the answer'),
  });

  const fillGaps = useMutation({
    mutationFn: () => documentsApi.fill(projectId, draft!.id),
    onSuccess: () => {
      refresh();
      notify({ title: 'Document filled', detail: 'Your answers were written into the matching blanks.' });
    },
    onError: fail('Could not fill the document'),
  });

  const approve = useMutation({
    mutationFn: (documentId: string) => documentsApi.approve(projectId, documentId),
    onSuccess: () => {
      refresh();
      notify({ title: 'Document confirmed', detail: 'This version can now enter the approved planning baseline.' });
    },
    onError: fail('Could not confirm'),
  });

  const exportPack = useMutation({
    mutationFn: () => documentsApi.export(projectId, 'DOCX'),
    onSuccess: () =>
      notify({
        title: 'Approved baseline prepared',
        detail: 'Drafts, unanswered blanks and unconfirmed AI content were excluded.',
      }),
    onError: fail('Export not possible'),
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
  const gaps = draft?.gaps ?? [];
  const answeredCount = gaps.filter((gap) => gap.answer?.trim()).length;
  const isApproved = draft?.status === 'APPROVED';

  const startEditing = () => {
    setEditSections((draft?.sections ?? []).map((section) => ({ title: section.title, content: section.content ?? '' })));
    setEditing(true);
  };

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PLANNING FLOW 3 · GENERATE &amp; APPROVE</p>
          <h1>Pick a document and let the AI write it.</h1>
          <span>
            The AI chooses the structure from the project type and the confirmed governance model. It never invents a
            missing fact — every blank becomes a question for you on the right.
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
              <p>
                {draft && draft.status !== 'NOT_GENERATED'
                  ? `Version ${draft.version} · ${draft.sections.length} sections written by the AI.`
                  : 'Not generated yet. The AI will decide the structure from this project’s verified inputs.'}
              </p>
            </div>
            <button
              className="primary"
              onClick={() => generate.mutate()}
              disabled={generate.isPending || !selected || isApproved}
              title={isApproved ? 'Approved documents are versioned — they cannot be regenerated' : undefined}
            >
              {generate.isPending
                ? '✦ Generating…'
                : draft && draft.status !== 'NOT_GENERATED'
                  ? '✦ Regenerate document'
                  : '✦ Generate document'}
            </button>
          </div>

          {draft && draft.status !== 'NOT_GENERATED' ? (
            <section className="panel generated-preview">
              <div className="editor-head">
                <div>
                  <span className="doc-kicker">
                    {isApproved ? 'PM APPROVED · BASELINE' : 'AI DRAFT · PM REVIEW REQUIRED'}
                  </span>
                  <h2>
                    {selected?.name} — v{draft.version}
                  </h2>
                </div>
                <div>
                  {editing ? (
                    <>
                      <button className="secondary" onClick={() => setEditing(false)} disabled={saveContent.isPending}>
                        Cancel
                      </button>
                      <button className="primary" onClick={() => saveContent.mutate()} disabled={saveContent.isPending}>
                        {saveContent.isPending ? 'Saving…' : 'Save content'}
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="secondary" onClick={() => setPreviewing(true)}>
                        Preview
                      </button>
                      <button className="secondary" onClick={startEditing} disabled={isApproved}>
                        Edit content
                      </button>
                      <button
                        className="secondary"
                        onClick={() => documentsApi.downloadDocx(projectId, draft.id, selected?.name ?? 'document')}
                      >
                        Download .docx
                      </button>
                      <button
                        className="primary"
                        disabled={isApproved || approve.isPending}
                        onClick={() => approve.mutate(draft.id)}
                      >
                        {isApproved ? '✓ Confirmed by PM' : '✓ PM confirm'}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="source-strip">
                <span>✦</span>
                <p>
                  <strong>Generated from:</strong> PM-verified inputs and the confirmed governance model. Structure
                  chosen by the AI.
                </p>
              </div>

              {editing ? (
                <div className="editor-body editing">
                  {editSections.map((section, index) => (
                    <div className="edit-section" key={index}>
                      <input
                        value={section.title}
                        onChange={(event) =>
                          setEditSections((current) =>
                            current.map((item, i) => (i === index ? { ...item, title: event.target.value } : item)),
                          )
                        }
                        placeholder="Section title"
                      />
                      <textarea
                        rows={Math.max(4, Math.ceil(section.content.length / 90))}
                        value={section.content}
                        onChange={(event) =>
                          setEditSections((current) =>
                            current.map((item, i) => (i === index ? { ...item, content: event.target.value } : item)),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="secondary danger"
                        onClick={() => setEditSections((current) => current.filter((_, i) => i !== index))}
                      >
                        Remove section
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setEditSections((current) => [...current, { title: 'New section', content: '' }])}
                  >
                    + Add section
                  </button>
                </div>
              ) : (
                <div className="editor-body">
                  {draft.sections
                    .filter((section) => section.included && section.content)
                    .map((section) => (
                      <div key={section.id}>
                        <h3>{section.title}</h3>
                        <SectionText content={section.content ?? ''} />
                      </div>
                    ))}
                </div>
              )}
            </section>
          ) : (
            <div className="program-empty">
              Nothing generated yet. Press <strong>Generate document</strong> above — the AI reads the verified inputs
              and the confirmed governance model, then writes this document.
            </div>
          )}
        </main>

        <aside className="panel template-inspector">
          <span className="ai-label">PM CONFIRMATION NEEDED</span>
          {!draft || draft.status === 'NOT_GENERATED' ? (
            <p className="template-disclaimer">Generate the document first — anything the AI cannot source appears here.</p>
          ) : gaps.length === 0 ? (
            <p className="template-disclaimer">
              ✓ Nothing outstanding. Every fact in this document came from your verified project inputs.
            </p>
          ) : (
            <>
              <p className="template-disclaimer">
                The AI left {gaps.length} blank{gaps.length === 1 ? '' : 's'} rather than guessing. Answer them, then
                write them into the document.
              </p>
              <div className="gap-list">
                {gaps.map((gap) => (
                  <div className={`gap-item${gap.answer?.trim() ? ' answered' : ''}`} key={gap.token}>
                    <p>{gap.question}</p>
                    {gap.answer?.trim() ? <small>{gap.answer}</small> : null}
                    <button className="secondary" onClick={() => setAnswering(gap)} disabled={isApproved}>
                      {gap.answer?.trim() ? 'Edit answer' : 'Answer'}
                    </button>
                  </div>
                ))}
              </div>
              <button
                className="primary fill-button"
                onClick={() => fillGaps.mutate()}
                disabled={fillGaps.isPending || answeredCount === 0 || isApproved}
                title={answeredCount === 0 ? 'Answer at least one question first' : undefined}
              >
                {fillGaps.isPending ? 'Filling…' : `Fill out the document (${answeredCount})`}
              </button>
            </>
          )}
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

      {previewing && (
        <DocumentPreview
          document={draft ? { ...draft, name: selected?.name ?? 'Document' } : null}
          projectName={workspace.data?.name ?? ''}
          onClose={() => setPreviewing(false)}
          onDownload={() => documentsApi.downloadDocx(projectId, draft!.id, selected?.name ?? 'document')}
        />
      )}

      <Backdrop open={answering !== null} onClose={() => setAnswering(null)} />
      <AnswerGapModal
        gap={answering}
        busy={answerGap.isPending}
        onClose={() => setAnswering(null)}
        onSubmit={(answer) => answering && answerGap.mutate({ token: answering.token, answer })}
      />
    </section>
  );
}

function AnswerGapModal({
  gap,
  busy,
  onClose,
  onSubmit,
}: {
  gap: DocumentGap | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState('');

  useEffect(() => {
    setAnswer(gap?.answer ?? '');
  }, [gap]);

  return (
    <ModalShell open={gap !== null} className="create-project-modal structure-modal">
      <div className="modal-head">
        <span className="agent-orb">?</span>
        <div>
          <small>PM CONFIRMATION NEEDED</small>
          <h2>Answer this</h2>
        </div>
        <button className="close-modal" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (answer.trim()) onSubmit(answer.trim());
        }}
      >
        <div className="rationale">
          <h3>{gap?.question}</h3>
          <p>
            Your answer is written verbatim into the blank this question came from — the rest of the document is not
            touched.
          </p>
        </div>
        <label>
          Answer *
          <input value={answer} onChange={(event) => setAnswer(event.target.value)} required autoFocus />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save answer'}
          </button>
        </div>
      </form>
    </ModalShell>
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
