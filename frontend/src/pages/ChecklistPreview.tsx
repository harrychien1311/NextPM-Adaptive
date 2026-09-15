import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customersApi } from '../api/endpoints';

/**
 * Shows what the parser actually read out of a customer's checklist file, grouped the way the
 * source groups it.
 *
 * This screen exists for one reason: a checklist parsed from someone else's spreadsheet or Word
 * file is a guess until a human compares it to the original. So the parse note, the item count and
 * a link to the original file are all in view, and the rows are shown verbatim — untranslated, in
 * the source's own language — so the comparison is possible at a glance.
 */
export function ChecklistPreview({
  checklistId,
  title,
  onClose,
}: {
  checklistId: string;
  title: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: ['checklist', checklistId],
    queryFn: () => customersApi.checklistItems(checklistId),
  });

  const [search, setSearch] = useState('');

  // Escape closes, and the page behind must not scroll under the overlay.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const items = detail.data?.items ?? [];

  const groups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const visible = query
      ? items.filter(
          (item) =>
            item.text.toLowerCase().includes(query) ||
            (item.section ?? '').toLowerCase().includes(query) ||
            (item.guidance ?? '').toLowerCase().includes(query),
        )
      : items;

    const bySection = new Map<string, typeof visible>();
    for (const item of visible) {
      const key = item.section ?? 'Ungrouped';
      bySection.set(key, [...(bySection.get(key) ?? []), item]);
    }
    return [...bySection.entries()];
  }, [items, search]);

  return (
    <div className="doc-preview-overlay" role="dialog" aria-label={`${title} items`}>
      <div className="doc-preview-bar">
        <div>
          <strong>{title}</strong>
          <small>
            {detail.data ? (
              <>
                v{detail.data.version} · {items.length} item{items.length === 1 ? '' : 's'} ·{' '}
                {detail.data.customer.name}
              </>
            ) : (
              'Loading…'
            )}
          </small>
        </div>
        <div>
          <input
            className="checklist-search"
            placeholder="Search items…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {detail.data && (
            <button
              className="secondary"
              onClick={() => customersApi.downloadChecklist(checklistId, detail.data!.sourceFile)}
            >
              Open original
            </button>
          )}
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="doc-preview-scroll" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <article className="doc-page">
          {detail.isLoading && (
            <p className="state-block">
              <span className="inline-spinner" /> Reading the checklist…
            </p>
          )}

          {detail.data && (
            <>
              <h1>{detail.data.name}</h1>
              <p className="doc-meta">
                <b>{detail.data.customer.name}</b>
                <span>
                  {' '}
                  · version {detail.data.version} · {detail.data.sourceFile}
                </span>
              </p>
              {detail.data.parseNote && <p className="checklist-parse-note">{detail.data.parseNote}</p>}

              {!groups.length && <p className="customer-empty">Nothing matches “{search}”.</p>}

              {groups.map(([section, rows]) => (
                <section key={section} className="checklist-group">
                  <h2>
                    {section} <em>{rows.length}</em>
                  </h2>
                  <table className="checklist-table">
                    <thead>
                      <tr>
                        <th className="col-order">#</th>
                        <th>Check</th>
                        <th className="col-answer">Answer in source</th>
                        <th className="col-note">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((item) => (
                        <tr key={item.id}>
                          <td className="col-order">{item.order}</td>
                          <td>{item.text}</td>
                          <td className="col-answer">{item.expected ?? <span className="muted">—</span>}</td>
                          <td className="col-note">{item.guidance ?? <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </>
          )}
        </article>
      </div>
    </div>
  );
}
