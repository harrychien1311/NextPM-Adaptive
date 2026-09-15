import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardExportApi, documentsApi, projectApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { DocumentPreview, OrgChartFigure, SheetGrid, isChartDocument } from './DocumentPreview';
import { useReadOnlyGuard } from '../../hooks/useProjectWrite';
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
  // No PROJECT_PLAN tab: generating that workbook was retired (see `PROJECT_PLAN` in
  // data/document-catalog.ts). The enum value stays in the schema so old rows still read.
  // Its own tab: the kickoff deck is the one output built from the customer's own file, and it is
  // what a PM looks for by name — it should not be hunted for among the stakeholder documents.
  { domain: 'KICKOFF', label: 'Kickoff', glyph: '▶', tone: 'cyan' },
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

  /**
   * The studio is frozen for a reader: every control here leads to changing the document pack, so
   * each one explains itself instead of quietly doing nothing.
   */
  const { canWrite, guard, lockClass, lockedProps } = useReadOnlyGuard(projectId);

  /**
   * After an analysis, the Studio shows what that analysis said is missing — not all twenty-odd
   * catalog documents. The point of the gap list is that *these* are the ones this project needs,
   * and burying them among the rest throws that away.
   *
   * `inPlanningGap === null` on every entry means no analysis has tied a gap to a document, and the
   * whole catalog is shown: hiding everything because the model named nothing would leave the PM
   * unable to generate anything at all. The toggle is always there, because "show me the rest" is
   * a reasonable thing to want and a filter with no escape is a trap.
   */
  const [gapsOnly, setGapsOnly] = useState(true);
  const hasGapFilter = (data?.catalog ?? []).some((entry) => entry.inPlanningGap !== null);

  /**
   * Every count on this screen is taken from the documents actually on it.
   *
   * They used to come from the full catalog and from the server's `domains` summary, so a Studio
   * showing five documents still announced "0/22 generated" and a Governance tab read 4 when one
   * document sat under it. A number describing a list the PM cannot see is worse than no number:
   * it makes the work look untouched however much of it is done.
   */
  const shown = useMemo(
    () => (data?.catalog ?? []).filter((entry) => !gapsOnly || !hasGapFilter || entry.inPlanningGap === true),
    [data, gapsOnly, hasGapFilter],
  );

  const countByDomain = useMemo(
    () =>
      shown.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.domain] = (counts[entry.domain] ?? 0) + 1;
        return counts;
      }, {}),
    [shown],
  );

  // A domain with nothing in it is not a tab worth showing — it is a dead end with a zero on it.
  const visibleTabs = DOMAIN_TABS.filter((tab) => (countByDomain[tab.domain] ?? 0) > 0);
  // Hiding the tab the PM is standing on would leave them on an empty panel with nothing
  // highlighted, so the selection follows the list rather than the other way round.
  const activeDomain = visibleTabs.some((tab) => tab.domain === domain) ? domain : visibleTabs[0]?.domain ?? domain;

  const domainDocs = useMemo(
    () => shown.filter((entry) => entry.domain === activeDomain),
    [shown, activeDomain],
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

  const generated = shown.filter((entry) => entry.document && entry.document.status !== 'NOT_GENERATED').length;
  const approved = shown.filter((entry) => entry.document?.status === 'APPROVED').length;
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
              {generated}/{shown.length}
            </strong>
            <span>generated</span>
          </div>
          <div>
            <strong>
              {approved}/{shown.length}
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
        </div>
      </div>

      {hasGapFilter && (
        <div className="gap-filter-bar">
          <span>
            {gapsOnly
              ? 'Showing only the documents the planning analysis says are missing, plus the kickoff deck.'
              : 'Showing every document in the catalog.'}
          </span>
          <button className="text-button" onClick={() => setGapsOnly((only) => !only)}>
            {gapsOnly ? 'Show all documents' : 'Show only what is missing'}
          </button>
        </div>
      )}

      <div className="domain-tabs">
        {visibleTabs.map((tab) => (
          <button
            key={tab.domain}
            className={`${activeDomain === tab.domain ? 'active' : ''}${lockClass}`}
            {...lockedProps}
            onClick={guard(() => {
              setDomain(tab.domain);
              setDefinitionId(null);
            })}
          >
            <span className={`domain-glyph ${tab.tone}`}>{tab.glyph}</span>
            {/* The count of what this tab will actually show, not of what the catalog holds. */}
            {tab.label} <b>{countByDomain[tab.domain] ?? 0}</b>
          </button>
        ))}
      </div>

      <div className="template-workspace">
        <aside className="panel document-catalog">
          <div className="catalog-head">
            <div>
              <h2>{DOMAIN_TABS.find((tab) => tab.domain === activeDomain)?.label} documents</h2>
              <p>Recommended for this project</p>
            </div>
          </div>
          <div>
            {domainDocs.map((entry) => (
              <button
                key={entry.definitionId}
                className={`catalog-item${selected?.definitionId === entry.definitionId ? ' active' : ''}${lockClass}`}
                {...lockedProps}
                onClick={guard(() => setDefinitionId(entry.definitionId))}
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
              {/*
                A document with a customer template is produced by filling that customer's own
                file, not by drafting prose — so say so plainly, and count blanks rather than
                sections, because that is what the PM will be working through.
              */}
              {selected?.customerTemplate?.usableForFill ? (
                <p>
                  {draft && draft.status !== 'NOT_GENERATED'
                    ? `Version ${draft.version} · ${draft.sections.length} of the template’s blanks filled from this project’s data.`
                    : selected.customerTemplate.house
                      ? `Not generated yet. Generating fills the standard ${selected.customerTemplate.fileType} template in place — the one every project uses, whoever the customer — and anything the project data cannot answer becomes a question for you below.`
                      : `Not generated yet. Generating fills ${selected.customerTemplate.customerName}’s own ${selected.customerTemplate.fileType} template in place — their layout and branding are kept, and anything the project data cannot answer becomes a question for you below.`}
                </p>
              ) : (
                <p>
                  {draft && draft.status !== 'NOT_GENERATED'
                    ? `Version ${draft.version} · ${draft.sections.length} sections written by the AI.`
                    : 'Not generated yet. The AI will decide the structure from this project’s verified inputs.'}
                </p>
              )}
              {/*
                When a deck falls back to the neutral layout, say which customer name failed to
                match. "Why is this not our template?" is otherwise unanswerable from this screen,
                and the answer is almost always the Customer field.
              */}
              {selected?.exportFormat === 'PPTX' && !selected.customerTemplate && (
                <p className="template-source warn">
                  {workspace.data?.customer ? (
                    <>
                      No customer template matched <b>{workspace.data.customer}</b>, so this builds a neutral deck
                      carrying that customer’s logo. Add the spelling as an alias, or upload their kickoff template,
                      in the Customer library.
                    </>
                  ) : (
                    <>
                      This project has no Customer set, so no customer template can be matched and this builds a
                      neutral deck. Set it on Project Input.
                    </>
                  )}
                </p>
              )}
              {selected?.customerTemplate && (
                <p className={`template-source${selected.customerTemplate.usableForFill ? '' : ' warn'}`}>
                  {selected.customerTemplate.house
                    ? 'Standard template (all customers)'
                    : `${selected.customerTemplate.customerName} template`}
                  : <b>{selected.customerTemplate.sourceFile}</b> · {selected.customerTemplate.placeholders.length}{' '}
                  blank{selected.customerTemplate.placeholders.length === 1 ? '' : 's'}
                  {/*
                    An outline template is not a defect in the app, it is a fact about the file —
                    so say what will happen instead of silently doing something else.
                  */}
                  {!selected.customerTemplate.usableForFill && <> — {selected.customerTemplate.fillNote}</>}
                </p>
              )}
            </div>
            <button
              className={`primary${lockClass}`}
              {...lockedProps}
              onClick={guard(() => generate.mutate())}
              disabled={canWrite && (generate.isPending || !selected || isApproved)}
              title={
                canWrite && isApproved
                  ? 'Approved documents are versioned — they cannot be regenerated'
                  : lockedProps.title
              }
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
                      {/*
                        Preview and Download only read, so they stay live for a view-only account —
                        locking them would stop it from doing the one thing its access is for.

                        A deck gets no Preview button at all: slides are layout, images and the
                        customer's branding, and the only honest review of one is the file itself.
                        The org chart is a `.pptx` too but is drawn rather than listed, so it keeps
                        its preview.
                      */}
                      {!(selected?.exportFormat === 'PPTX' && !isChartDocument(selected?.name ?? '')) && (
                        <button className="secondary" onClick={() => setPreviewing(true)}>
                          Preview
                        </button>
                      )}
                      <button
                        className={`secondary${lockClass}`}
                        {...lockedProps}
                        onClick={guard(startEditing)}
                        disabled={canWrite && isApproved}
                      >
                        Edit content
                      </button>
                      <button
                        className="secondary"
                        onClick={() =>
                          documentsApi.download(
                            projectId,
                            draft.id,
                            selected?.name ?? 'document',
                            selected?.exportFormat,
                          )
                        }
                      >
                        Download .{(selected?.exportFormat ?? 'DOCX').toLowerCase()}
                      </button>
                      <button
                        className={`primary${lockClass}`}
                        {...lockedProps}
                        disabled={canWrite && (isApproved || approve.isPending)}
                        onClick={guard(() => approve.mutate(draft.id))}
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
                  {/*
                    A chart or a register has no prose by design, so the working panel shows the
                    thing itself rather than an empty body. Same components the preview uses.
                  */}
                  {/organi[sz]ation chart|org chart/i.test(selected?.name ?? '') ? (
                    <OrgChartFigure chart={draft.structuredData?.orgChart ?? null} />
                  ) : selected?.tableColumns?.length ? (
                    <>
                      <div className="studio-grid-wrap">
                        <SheetGrid
                          columns={draft.structuredData?.table?.columns ?? selected.tableColumns}
                          rows={draft.structuredData?.table?.rows ?? []}
                        />
                      </div>
                      {!draft.structuredData?.table?.rows.length && (
                        <p className="org-chart-empty">
                          <b>No rows yet.</b> Press <b>Generate document</b> — a version produced before this
                          document became a table holds prose instead, and needs generating again.
                        </p>
                      )}
                    </>
                  ) : (
                    draft.sections
                      .filter((section) => section.included && section.content)
                      .map((section) => (
                        <div key={section.id}>
                          <h3>{section.title}</h3>
                          <SectionText content={section.content ?? ''} />
                        </div>
                      ))
                  )}
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
                    <button
                      className={`secondary${lockClass}`}
                      {...lockedProps}
                      onClick={guard(() => setAnswering(gap))}
                      disabled={canWrite && isApproved}
                    >
                      {gap.answer?.trim() ? 'Edit answer' : 'Answer'}
                    </button>
                  </div>
                ))}
              </div>
              <button
                className={`primary fill-button${lockClass}`}
                {...lockedProps}
                onClick={guard(() => fillGaps.mutate())}
                disabled={canWrite && (fillGaps.isPending || answeredCount === 0 || isApproved)}
                title={
                  canWrite && answeredCount === 0 ? 'Answer at least one question first' : lockedProps.title
                }
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
          <button
            className={`primary${lockClass}`}
            {...lockedProps}
            onClick={guard(() => exportPack.mutate())}
            disabled={canWrite && exportPack.isPending}
          >
            {exportPack.isPending ? 'Preparing…' : 'Export approved baseline'}
          </button>
        </div>
      </div>

      {previewing && (
        <DocumentPreview
          document={
            draft
              ? {
                  ...draft,
                  name: selected?.name ?? 'Document',
                  exportFormat: selected?.exportFormat,
                  tableColumns: selected?.tableColumns ?? null,
                }
              : null
          }
          projectId={projectId}
          projectName={workspace.data?.name ?? ''}
          onClose={() => setPreviewing(false)}
          onDownload={() =>
            documentsApi.download(projectId, draft!.id, selected?.name ?? 'document', selected?.exportFormat)
          }
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
