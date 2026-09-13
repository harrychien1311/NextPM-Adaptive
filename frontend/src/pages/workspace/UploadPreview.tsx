import { useQuery } from '@tanstack/react-query';
import { inputApi } from '../../api/endpoints';

/**
 * Preview for a file the PM uploaded, as opposed to a document the AI wrote.
 *
 * There is no rendered version of an upload to show — it is whatever .pdf/.docx the PM had. So
 * this shows the text the app extracted on upload (the same text the agent reads) and links to
 * the original bytes, which the browser opens in its own viewer.
 */
export function UploadPreview({
  projectId,
  fileId,
  fileName,
  onClose,
}: {
  projectId: string;
  fileId: string | null;
  fileName: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['reference', projectId, fileId],
    queryFn: () => inputApi.reference(projectId, fileId!),
    enabled: Boolean(fileId),
  });

  if (!fileId) return null;

  return (
    <div className="doc-preview-overlay" role="dialog" aria-label={`${fileName} preview`}>
      <div className="doc-preview-bar">
        <div>
          <strong>{fileName}</strong>
          <small>{data ? `${data.group} · uploaded by the PM` : 'Uploaded file'}</small>
        </div>
        <div>
          <a
            className="secondary"
            href={inputApi.referenceFileUrl(projectId, fileId)}
            target="_blank"
            rel="noreferrer"
          >
            Open original
          </a>
          <button className="secondary" onClick={onClose}>
            Close preview
          </button>
        </div>
      </div>

      <div className="doc-preview-scroll" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <article className="doc-page">
          <h1>{fileName}</h1>
          <p className="doc-meta">
            <b>Uploaded document</b>
            {data ? (
              <span>
                {' '}
                · {Math.max(1, Math.round(data.sizeBytes / 1024))} KB ·{' '}
                {new Date(data.uploadedAt).toLocaleString()}
              </span>
            ) : null}
          </p>
          <p className="doc-note">
            This is the text the app extracted from your file — the same text the agent reads. Use “Open original”
            for the file exactly as you uploaded it.
          </p>

          {isLoading && (
            <p>
              <span className="inline-spinner" /> Loading…
            </p>
          )}

          {data && !data.textAvailable && (
            <p className="doc-note">
              No text could be read from this file. That happens with scanned PDFs (an image of a page has no text
              layer) and with legacy formats like .doc or .xls. The original is still stored — open it above.
            </p>
          )}

          {data?.text && <pre className="doc-extract">{data.text}</pre>}
        </article>
      </div>
    </div>
  );
}
