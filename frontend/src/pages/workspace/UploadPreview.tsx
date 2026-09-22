import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { inputApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';

/**
 * Preview for a file the PM uploaded, as opposed to a document the AI wrote.
 *
 * Two views, because a PM asks two different questions about the same file and neither answers the
 * other:
 *
 * - **Original** — the file exactly as uploaded, rendered by the browser itself. This is the
 *   default: "show me my document" is what clicking a document means, and a panel that opens on a
 *   wall of extracted plain text reads as though the file itself were lost.
 * - **Extracted text** — what the app actually read out of it, which is what every AI call sees. A
 *   scanned PDF looks perfect and yields nothing; this is the only place that is visible. It sits
 *   on the right, one click away, for exactly that question.
 */

/** What a browser will render in an iframe. Everything else is offered as a download instead. */
const EMBEDDABLE = /^(application\/pdf|text\/|image\/)/;

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
  const notify = useToast();
  const [tab, setTab] = useState<'text' | 'original'>('original');

  const { data, isLoading } = useQuery({
    queryKey: ['reference', projectId, fileId],
    queryFn: () => inputApi.reference(projectId, fileId!),
    enabled: Boolean(fileId),
  });

  /**
   * The original, fetched with the session token and held as a `blob:` URL.
   *
   * It cannot be an ordinary `src` pointing at the API: a browser-issued iframe request carries no
   * Authorization header and is answered 401. Fetched only once the PM opens the tab — an upload is
   * routinely a few hundred KB and most previews never leave the text view.
   */
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const canEmbed = data ? EMBEDDABLE.test(data.mimeType) : false;

  useEffect(() => {
    if (tab !== 'original' || !fileId || blobUrl || !canEmbed) return;
    let cancelled = false;
    setLoadingFile(true);
    inputApi
      .referenceFileObjectUrl(projectId, fileId)
      .then((url) => {
        // The panel may have closed while the bytes were in flight; revoke rather than leak.
        if (cancelled) URL.revokeObjectURL(url);
        else setBlobUrl(url);
      })
      .catch((error) => notify({ title: 'Could not load the original', detail: (error as Error).message }))
      .finally(() => !cancelled && setLoadingFile(false));
    return () => {
      cancelled = true;
    };
  }, [tab, fileId, projectId, blobUrl, canEmbed, notify]);

  // One blob per file. Switching to another upload must not leave the previous one embedded.
  useEffect(() => {
    setTab('original');
    setBlobUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  }, [fileId]);

  useEffect(
    () => () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    },
    [blobUrl],
  );

  if (!fileId) return null;

  return (
    <div className="doc-preview-overlay" role="dialog" aria-label={`${fileName} preview`}>
      <div className="doc-preview-bar">
        <div>
          <strong>{fileName}</strong>
          <small>{data ? `${data.group} · uploaded by the PM` : 'Uploaded file'}</small>
        </div>
        <div>
          {/* The original first, because it is what the panel opens on; the extracted text sits to
              its right as the thing you switch to when the document alone does not answer you. */}
          <div className="preview-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'original'} onClick={() => setTab('original')}>
              View original
            </button>
            <button role="tab" aria-selected={tab === 'text'} onClick={() => setTab('text')}>
              View extracted text
            </button>
          </div>
          <button className="secondary" onClick={onClose}>
            Close preview
          </button>
        </div>
      </div>

      {tab === 'original' ? (
        <div className="doc-preview-scroll original-pane">
          {!data || loadingFile ? (
            <p className="doc-note">
              <span className="inline-spinner" /> Loading the original…
            </p>
          ) : canEmbed && blobUrl ? (
            <iframe className="original-frame" src={blobUrl} title={`${fileName} — original`} />
          ) : (
            <article className="doc-page">
              <h1>{fileName}</h1>
              {/*
                Word, Excel and PowerPoint have no in-browser renderer — an iframe of a .docx is a
                download prompt or a blank frame, which reads as a broken preview rather than as a
                format the browser cannot draw. Say so and hand over the file instead.
              */}
              <p className="doc-note">
                A browser cannot display this format in place. Open it in a new tab to let your
                operating system’s own application handle it — the file is exactly as you uploaded it.
              </p>
              <button
                className="primary"
                onClick={() =>
                  inputApi
                    .openReferenceFile(projectId, fileId)
                    .catch((error) =>
                      notify({ title: 'Could not open the original', detail: (error as Error).message }),
                    )
                }
              >
                Open original in a new tab
              </button>
            </article>
          )}
        </div>
      ) : (
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
              This is the text the app extracted from your file — the same text the agent reads. If
              something here is missing, the analysis could not see it either. Switch back to{' '}
              <b>View original</b> for the document itself.
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
      )}
    </div>
  );
}
