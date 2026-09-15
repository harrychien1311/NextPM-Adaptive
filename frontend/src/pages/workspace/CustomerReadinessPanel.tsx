import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checklistApi } from '../../api/endpoints';
import type { ChecklistAssessedItem, ChecklistStatus } from '../../api/types';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';
import { useProjectWrite } from '../../hooks/useProjectWrite';

/**
 * How far this project meets what its customer requires.
 *
 * The point of this panel is that the input-form readiness score answers *our* question ("how much
 * of our form is filled in") while this one answers the customer's ("can you evidence the things
 * we asked for"). So it never shows a bare number: every item carries the evidence its status
 * rests on and who decided it, because a readiness score nobody can audit is not evidence of
 * readiness — it is a claim.
 *
 * `UNKNOWN` is displayed as its own thing, never folded into "not met". "We have not checked" and
 * "we checked and it is missing" are different facts and a PM has to be able to tell them apart.
 */

const STATUS_LABEL: Record<ChecklistStatus, string> = {
  MET: 'Met',
  PARTIAL: 'Partial',
  NOT_MET: 'Not met',
  NOT_APPLICABLE: 'N/A',
  UNKNOWN: 'Not checked',
};

const STATUS_ORDER: ChecklistStatus[] = ['NOT_MET', 'UNKNOWN', 'PARTIAL', 'MET', 'NOT_APPLICABLE'];

const SOURCE_LABEL: Record<string, string> = {
  DETERMINISTIC: 'matched from project inputs',
  AI: 'assessed by the agent',
  PM: 'confirmed by the PM',
};

/**
 * Write actions are gated server-side by `requireProjectRole`, and the buttons are disabled for a
 * reader so they are never invited to press something the server will refuse.
 */
export function CustomerReadinessPanel({ projectId }: { projectId: string }) {
  const canWrite = useProjectWrite(projectId);
  const notify = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | ChecklistStatus>('all');
  const [openItem, setOpenItem] = useState<string | null>(null);

  /**
   * Which of the customer's sections are unfolded. All closed to begin with: a checklist runs to
   * thirty-odd items across half a dozen sections, and rendering them all made the panel the
   * longest thing on the page by a distance. The per-section score bars above stay visible, so the
   * shape of the result is never hidden — only the individual lines are.
   */
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  /** Takes the state the header is actually showing, so one click always flips what is on screen. */
  const toggleSection = (section: string, isOpen: boolean) =>
    setOpenSections((current) => ({ ...current, [section]: !isOpen }));

  const readiness = useQuery({
    queryKey: ['checklist', projectId],
    queryFn: () => checklistApi.readiness(projectId),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['checklist', projectId] });
    // The blended project readiness moves with it.
    queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
    queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
  };

  const assess = useMutation({
    mutationFn: (onlyUnmet: boolean) => checklistApi.assess(projectId, onlyUnmet),
    onSuccess: (result) => {
      refresh();
      notify({
        title: 'Checklist re-assessed',
        detail:
          result.provider === 'anthropic'
            ? `${result.sentToModel} item(s) went to the agent.`
            : 'No AI provider is configured, so items nothing could match deterministically were left unchecked.',
      });
    },
    onError: (error) =>
      notify({
        title: 'Could not re-assess',
        detail: error instanceof ApiError ? error.message : 'Unexpected error',
      }),
  });

  const setItem = useMutation({
    mutationFn: ({ itemId, status }: { itemId: string; status: ChecklistStatus }) =>
      checklistApi.setItem(projectId, itemId, status),
    onSuccess: () => {
      refresh();
      notify({ title: 'Your verdict is recorded', detail: 'A re-assessment will not overwrite it.' });
    },
    onError: (error) =>
      notify({ title: 'Could not save', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const data = readiness.data;

  const grouped = useMemo(() => {
    if (!data?.applies) return [];
    const visible = filter === 'all' ? data.items : data.items.filter((item) => item.status === filter);
    const bySection = new Map<string, ChecklistAssessedItem[]>();
    for (const item of visible) {
      const key = item.section ?? 'Ungrouped';
      bySection.set(key, [...(bySection.get(key) ?? []), item]);
    }
    return [...bySection.entries()];
  }, [data, filter]);

  if (readiness.isLoading) {
    return (
      <section className="panel">
        <div className="state-block">
          <span className="inline-spinner" /> Checking the customer checklist…
        </div>
      </section>
    );
  }

  if (!data?.applies) {
    return (
      <section className="panel customer-readiness">
        <header className="panel-head">
          <div>
            <h3>Project readiness by customer standardization</h3>
            <small>Measured against the standards the customer sets for their own projects</small>
          </div>
        </header>
        <p className="customer-empty">
          {data?.reason ?? 'No customer checklist applies to this project.'}{' '}
          {data && 'typedCustomer' in data && data.typedCustomer
            ? 'Add that spelling as an alias in the Customer library, or upload their checklist there.'
            : 'Set the project’s Customer field to match a customer in the library.'}
        </p>
      </section>
    );
  }

  const { score, assessment } = data;
  const tone = score.score >= 85 ? 'green' : score.score >= 55 ? 'amber' : 'red';

  return (
    <section className="panel customer-readiness">
      <header className="panel-head">
        <div>
          <h3>Project readiness by customer standardization</h3>
          {/*
            Say what is being measured before saying which file it came from. "AGS Operational
            Readiness Checklist.docx v1" tells a PM nothing about why their project is scored
            against it; naming the customer whose standard it is does.
          */}
          <small>
            These criteria are standardized and set by <b>{data.customer.name}</b> for the projects they
            commission — this project is measured against them, not against our own form.
          </small>
          <small className="customer-source">
            Source: {data.checklist.name} v{data.checklist.version} · matched on “{data.match.matchedOn}”
            {data.match.confidence === 'partial' && ' (partial match)'}
          </small>
        </div>
        {canWrite && (
          <div className="panel-actions">
            <button className="secondary" disabled={assess.isPending} onClick={() => assess.mutate(true)}>
              {assess.isPending ? 'Assessing…' : 'Assess new evidence'}
            </button>
            <button className="secondary" disabled={assess.isPending} onClick={() => assess.mutate(false)}>
              Re-assess everything
            </button>
          </div>
        )}
      </header>

      <div className="readiness-headline">
        <div className={`readiness-dial ${tone}`}>
          <strong>{score.score}%</strong>
          <span>of {score.applicable} applicable</span>
        </div>
        <div className="readiness-facts">
          <p>
            <b>{score.assessed}</b> of {score.applicable} items assessed ({score.coverage}% coverage)
            {score.notApplicable > 0 && (
              <>
                {' · '}
                <b>{score.notApplicable}</b> out of scope, excluded from the score
              </>
            )}
          </p>
          {assessment.stale && (
            <p className="readiness-warn">
              Out of date — inputs or documents changed since this ran. Press “Assess new evidence”.
            </p>
          )}
          {assessment.runState === 'RUNNING' && (
            <p className="readiness-warn">
              <span className="inline-spinner" /> An assessment is running in the background.
            </p>
          )}
          {assessment.runState === 'ERROR' && assessment.lastError && (
            <p className="readiness-warn">Last assessment failed: {assessment.lastError}</p>
          )}
          {assessment.assessedAt && assessment.aiProvider !== 'anthropic' && (
            <p className="readiness-warn">
              No AI provider ran, so only items matched directly from project inputs were assessed. The rest are
              genuinely unchecked, not failing.
            </p>
          )}
          {!assessment.assessedAt && <p className="readiness-warn">Not assessed yet.</p>}
        </div>
      </div>

      <div className="readiness-filters">
        <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
          All <b>{data.items.length}</b>
        </button>
        {STATUS_ORDER.map((status) => {
          const count = data.items.filter((item) => item.status === status).length;
          if (!count) return null;
          return (
            <button
              key={status}
              className={`status-${status.toLowerCase()}${filter === status ? ' active' : ''}`}
              onClick={() => setFilter(status)}
            >
              {STATUS_LABEL[status]} <b>{count}</b>
            </button>
          );
        })}
      </div>

      <div className="readiness-sections">
        {data.sections.map((section) => (
          <div className="readiness-section-bar" key={section.section}>
            <span title={section.sectionEn ? section.section : undefined}>
              {section.sectionEn ?? section.section}
            </span>
            <div className="readiness-bar">
              <i style={{ width: `${section.score}%` }} />
            </div>
            <b>{section.score}%</b>
          </div>
        ))}
      </div>

      <ul className="readiness-items">
        {grouped.map(([section, items]) => {
          /*
            Collapsed unless the PM opened it — or unless a status filter is on, since filtering to
            "Not met" is itself a request to see those lines. An explicit toggle still wins over
            that default, so the header never becomes a button that does nothing.
          */
          const isOpen = openSections[section] ?? filter !== 'all';
          const met = items.filter((item) => item.status === 'MET').length;
          return (
            <li key={section} className={`readiness-group${isOpen ? ' open' : ''}`}>
              {/* The heading is the customer's own grouping; show it in English with their word kept. */}
              <button
                type="button"
                className="readiness-group-head"
                aria-expanded={isOpen}
                onClick={() => toggleSection(section, isOpen)}
              >
                <span className="readiness-chevron">{isOpen ? '▴' : '▾'}</span>
                <h4>
                  {items[0]?.sectionEn ?? section}
                  {items[0]?.sectionEn && section !== 'Ungrouped' && (
                    <small className="readiness-original">{section}</small>
                  )}
                </h4>
                {/* Counts stay on the closed header: folding detail away must not fold away the facts. */}
                <span className="readiness-group-count">
                  {met}/{items.length} met
                </span>
              </button>
              {isOpen && (
            <ul>
              {items.map((item) => (
                <li key={item.id} className={`readiness-item status-${item.status.toLowerCase()}`}>
                  <button
                    className="readiness-item-head"
                    onClick={() => setOpenItem(openItem === item.id ? null : item.id)}
                  >
                    <span className="readiness-pill">{STATUS_LABEL[item.status]}</span>
                    {/*
                      English is what this screen reads; the customer's own wording sits under it,
                      because that is what the PM quotes back to them at the audit and what they
                      search their own file for. An item already in English has no second line.
                    */}
                    <span className="readiness-text">
                      {item.textEn ?? item.text}
                      {item.textEn && <small className="readiness-original">{item.text}</small>}
                    </span>
                    <span className="readiness-chevron">{openItem === item.id ? '▴' : '▾'}</span>
                  </button>
                  {openItem === item.id && (
                    <div className="readiness-item-body">
                      {item.evidence ? (
                        <p className="readiness-evidence">{item.evidence}</p>
                      ) : (
                        <p className="readiness-evidence muted">Nothing has been cited for this item yet.</p>
                      )}
                      {item.note && <p className="readiness-note">{item.note}</p>}
                      {item.guidance && (
                        <p className="readiness-guidance">
                          Source note: {item.guidanceEn ?? item.guidance}
                          {item.guidanceEn && <small className="readiness-original">{item.guidance}</small>}
                        </p>
                      )}
                      <p className="readiness-source">
                        {item.source ? SOURCE_LABEL[item.source] ?? item.source : 'not assessed yet'}
                      </p>
                      {canWrite && (
                        <div className="readiness-verdicts">
                          <span>Your verdict:</span>
                          {(['MET', 'PARTIAL', 'NOT_MET', 'NOT_APPLICABLE'] as ChecklistStatus[]).map((status) => (
                            <button
                              key={status}
                              className="secondary"
                              disabled={setItem.isPending}
                              onClick={() => setItem.mutate({ itemId: item.id, status })}
                            >
                              {STATUS_LABEL[status]}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
