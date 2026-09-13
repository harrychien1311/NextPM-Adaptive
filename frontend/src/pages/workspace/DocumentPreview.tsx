import type { CatalogEntry } from '../../api/types';

/** Capturing + global so `split` keeps the tokens as their own array entries. */
const GAP_SPLIT = /(\{\{gap:\d+\}\})/g;
/** Separate, non-global copy: `.test()` on a /g regex advances lastIndex between calls. */
const IS_GAP = /^\{\{gap:\d+\}\}$/;

/**
 * Renders one paragraph, turning any blank the model refused to guess into a visible marker
 * rather than leaking the raw `{{gap:N}}` token.
 */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(GAP_SPLIT).map((part, index) =>
        IS_GAP.test(part) ? (
          <mark className="gap-marker" key={index}>
            answer needed
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function Cell({ text }: { text: string }) {
  return (
    <td>
      <Prose text={text} />
    </td>
  );
}

/**
 * A read-only, page-shaped rendering of the planning document — the same title block, heading
 * colours and table styling the `.docx` export uses, so what the PM reviews on screen matches the
 * file they hand over. Deliberately not a Word file parsed in the browser: this reads from the
 * same data the export does, so the two cannot drift apart over a rendering library's quirks.
 */
export function DocumentPreview({
  entry,
  projectName,
  onClose,
  onDownload,
}: {
  entry: CatalogEntry | null;
  projectName: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  if (!entry?.document) return null;
  const document = entry.document;
  const raci = document.structuredData?.raciTable ?? [];
  const risks = document.structuredData?.riskRegister ?? [];

  return (
    <div className="doc-preview-overlay" role="dialog" aria-label={`${entry.name} preview`}>
      <div className="doc-preview-bar">
        <div>
          <strong>{entry.name}</strong>
          <small>
            v{document.version} · {document.status === 'APPROVED' ? 'PM approved · baseline' : 'AI draft · PM review required'}
          </small>
        </div>
        <div>
          <button className="secondary" onClick={onDownload}>
            Download .docx
          </button>
          <button className="secondary" onClick={onClose}>
            Close preview
          </button>
        </div>
      </div>

      <div className="doc-preview-scroll" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <article className="doc-page">
          <h1>{entry.name}</h1>
          <p className="doc-meta">
            <b>{projectName}</b>
            <span>
              {' '}
              · version {document.version} · {document.status}
            </span>
          </p>
          <p className="doc-note">
            AI-drafted from PM-verified project inputs. Highlighted blanks are facts the project data did not contain.
          </p>

          {document.sections
            .filter((section) => section.included && section.content)
            .map((section) => (
              <section key={section.id}>
                <h2>{section.title}</h2>
                {(section.content ?? '').split(/\n{2,}/).map((block, index) => (
                  <p key={index}>
                    <Prose text={block.trim()} />
                  </p>
                ))}
              </section>
            ))}

          {raci.length > 0 && (
            <section>
              <h2>RACI Matrix</h2>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Responsible</th>
                    <th>Accountable</th>
                    <th>Consulted</th>
                    <th>Informed</th>
                  </tr>
                </thead>
                <tbody>
                  {raci.map((row, index) => (
                    <tr key={index}>
                      <Cell text={row.activity} />
                      <Cell text={row.responsible} />
                      <Cell text={row.accountable} />
                      <Cell text={row.consulted} />
                      <Cell text={row.informed} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {risks.length > 0 && (
            <section>
              <h2>Risk Register</h2>
              <table className="doc-table">
                <thead>
                  <tr>
                    <th>Risk</th>
                    <th>Severity</th>
                    <th>Owner</th>
                    <th>Mitigation</th>
                  </tr>
                </thead>
                <tbody>
                  {risks.map((row, index) => (
                    <tr key={index}>
                      <Cell text={row.risk} />
                      <td>{row.severity}</td>
                      <Cell text={row.owner} />
                      <Cell text={row.mitigation} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {document.gaps.length > 0 && (
            <section>
              <h2>PM confirmation needed</h2>
              <p className="doc-note">
                These facts were not present in the project data, so they were left blank rather than guessed:
              </p>
              <ul className="doc-gap-list">
                {document.gaps.map((gap) => (
                  <li key={gap.token}>
                    {gap.question}
                    {gap.answer?.trim() ? <em> — answered: {gap.answer}</em> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      </div>
    </div>
  );
}
