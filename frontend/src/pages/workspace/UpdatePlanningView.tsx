import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inputApi, planChangeApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useProjectWrite } from '../../hooks/useProjectWrite';
import { PlanChangeView } from './PlanChangeView';
import type { PlanChange } from '../../api/types';
import type { NavigateToView } from '../WorkspacePage';

const UPLOAD_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt';
/** Mirrors the server's own limits for change uploads, so the box states them before it refuses. */
const MAX_CHANGE_DOCUMENTS = 10;
const MAX_CHANGE_UPLOAD_MB = 10;

/**
 * Update Planning — step 4 of the planning flow, shown once the PM has confirmed the Planning
 * Assessment.
 *
 * A change to a plan that already exists is its own step, not a mode of Project Input: recording
 * "what changed" and describing "what the project is" are different questions, and answering the
 * second while meaning the first is how a revised SOW ends up attached to neither. The whole change
 * lives here, in order:
 *
 *   1. record it — a note, the documents that carry it, and whether each replaces an earlier one;
 *   2. analyse it — the model returns only what the change moves;
 *   3. see the impact and apply or dismiss it (`PlanChangeView`).
 *
 * Which of those the screen shows is decided by the change's own status, so a refresh lands on the
 * right step.
 */
export function UpdatePlanningView({ projectId, onNavigate }: { projectId: string; onNavigate: NavigateToView }) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const canWrite = useProjectWrite(projectId);

  const planChange = useQuery({
    queryKey: ['plan-change', projectId],
    queryFn: () => planChangeApi.current(projectId),
  });
  const input = useQuery({
    queryKey: ['input', projectId],
    queryFn: () => inputApi.profile(projectId),
  });

  const openChange = planChange.data?.change ?? null;
  const [changeNote, setChangeNote] = useState('');
  /** Set when the PM steps back from an analysed change's impact to edit what they recorded. */
  const [editing, setEditing] = useState(false);

  /**
   * Load the stored note whenever a different change comes into view. Without this the textarea
   * started empty on every visit, and its `onBlur` then saved that emptiness over the PM's words.
   */
  const loadedNoteFor = useRef<string | null>(null);
  useEffect(() => {
    if (!openChange || loadedNoteFor.current === openChange.id) return;
    loadedNoteFor.current = openChange.id;
    setChangeNote(openChange.note ?? '');
  }, [openChange]);

  const refreshChange = () => queryClient.invalidateQueries({ queryKey: ['plan-change', projectId] });
  const refreshDashboard = () => queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });

  const startChange = useMutation({
    mutationFn: () => planChangeApi.start(projectId),
    onSuccess: async (created: PlanChange) => {
      setChangeNote(created.note ?? '');
      await refreshChange();
    },
    onError: (error) => notify({ title: 'Could not start a change', detail: (error as Error).message }),
  });

  /**
   * One call: save what the PM wrote, then measure it against the plan already on file. The note is
   * saved first, so a failed model call still leaves the PM's own words recorded.
   */
  const analyzeChange = useMutation({
    mutationFn: async () => {
      if (!openChange) throw new Error('No change is open');
      await planChangeApi.update(projectId, openChange.id, { note: changeNote.trim() || null });
      return planChangeApi.analyze(projectId, openChange.id);
    },
    onSuccess: async () => {
      await Promise.all([refreshChange(), queryClient.invalidateQueries({ queryKey: ['approach', projectId] })]);
      setEditing(false);
      notify({ title: 'Change analysed', detail: 'Here is what it moves. Apply it, or dismiss it.' });
    },
    onError: (error) =>
      notify({
        title: 'Could not analyse the change',
        detail: error instanceof ApiError ? error.message : (error as Error).message,
      }),
  });

  const uploadChangeDocument = useMutation({
    mutationFn: (file: File) => planChangeApi.uploadDocument(projectId, openChange!.id, file),
    onSuccess: async (result, file) => {
      await Promise.all([refreshChange(), queryClient.invalidateQueries({ queryKey: ['input', projectId] })]);
      refreshDashboard();
      notify({
        title: `${file.name} added to this change`,
        // Says what was assumed: it decides whether the document is compared against a predecessor
        // or read as new material, and it is a guess from the file name.
        detail: result.proposedReplacement
          ? `Proposed as a new version of ${result.proposedReplacement}. Change it on the row if that is wrong.`
          : 'Proposed as a new document. Set it as a new version on the row if it replaces something.',
      });
    },
    onError: (error) => notify({ title: 'Upload rejected', detail: (error as Error).message }),
  });

  const setChangeDocumentReplaces = useMutation({
    mutationFn: ({ referenceId, replaces }: { referenceId: string; replaces: string | null }) =>
      planChangeApi.setReplaces(projectId, openChange!.id, referenceId, replaces),
    onSuccess: refreshChange,
    onError: (error) => notify({ title: 'Could not set the version link', detail: (error as Error).message }),
  });

  /** ✕ deletes the file, here as everywhere else: the row, the extracted text and the bytes. */
  const removeChangeDocument = useMutation({
    mutationFn: (referenceId: string) => inputApi.removeReference(projectId, referenceId),
    onSuccess: async () => {
      await Promise.all([refreshChange(), queryClient.invalidateQueries({ queryKey: ['input', projectId] })]);
      refreshDashboard();
    },
    onError: (error) => notify({ title: 'Could not delete the document', detail: (error as Error).message }),
  });

  const cancelChange = useMutation({
    mutationFn: () => planChangeApi.dismiss(projectId, openChange!.id),
    onSuccess: async () => {
      setChangeNote('');
      setEditing(false);
      await refreshChange();
      notify({ title: 'Change discarded', detail: 'The plan is unchanged.' });
    },
    onError: (error) => notify({ title: 'Could not discard', detail: (error as Error).message }),
  });

  if (planChange.isLoading || input.isLoading) {
    return (
      <section className="view active">
        <div className="state-block">
          <span className="inline-spinner" /> Loading…
        </div>
      </section>
    );
  }

  // Step 3: an analysed change shows its impact, unless the PM has gone back to edit it.
  if (openChange?.status === 'ANALYZED' && !editing) {
    return <PlanChangeView projectId={projectId} change={openChange} onNavigate={onNavigate} onEdit={() => setEditing(true)} />;
  }

  const uploads = input.data?.uploads ?? [];

  return (
    <section className="view active">
      <div className="page-head compact">
        <div>
          <p>PLANNING FLOW 4 · UPDATE PLANNING</p>
          <h1>Record what changed.</h1>
          <span>
            A change in scope, team, timeline or contract. The analysis measures it against the plan already on file
            and updates only what it affects — approved documents are flagged, never rewritten.
          </span>
        </div>
      </div>

      {!openChange ? (
        <article className="panel">
          <div className="program-empty">
            Nothing is being changed right now. Start a change when the customer, the scope, the team or the dates move
            — you can describe it in words, upload the documents that carry it, or both.
          </div>
          <div className="modal-actions">
            <button className="primary" onClick={() => startChange.mutate()} disabled={!canWrite || startChange.isPending}>
              {startChange.isPending ? 'Opening…' : '⇄ Record a plan change'}
            </button>
          </div>
        </article>
      ) : (
        <article className="panel change-panel">
          <div className="panel-head">
            <div>
              <h2>⇄ Recording a plan change</h2>
              <p>
                Describe what changed, upload the document that carries it, or both. The analysis measures it against
                the plan already on file instead of reading the project again.
              </p>
            </div>
            {/* "Either one", because that is what the server enforces — it refuses only when both are empty. */}
            <span className="required-chip mandatory-chip">Mandatory * — a note or a document</span>
            <button className="ghost" onClick={() => cancelChange.mutate()} disabled={!canWrite || cancelChange.isPending}>
              Discard
            </button>
          </div>
          <label className="change-note">
            What changed? <em className="mandatory-mark">*</em>
            <textarea
              value={changeNote}
              onChange={(event) => setChangeNote(event.target.value)}
              onBlur={() =>
                openChange.note !== changeNote.trim() &&
                planChangeApi
                  .update(projectId, openChange.id, { note: changeNote.trim() || null })
                  .then(refreshChange)
                  .catch(() => undefined)
              }
              placeholder="e.g. The customer moved go-live from March to June and added a payments module to the scope."
              rows={3}
              disabled={!canWrite}
            />
          </label>

          {/*
            The documents this change brings, proposed automatically from everything uploaded since
            the last analysis and editable: sweeping in every upload catches unrelated files, and asking
            the PM to add each one by hand is how the second and third documents get forgotten.
          */}
          <div className="change-docs">
            <small>
              DOCUMENTS IN THIS CHANGE <em className="mandatory-mark">*</em>
            </small>
            {openChange.documents.length > 0 && (
              <ul>
                {openChange.documents.map((document) => {
                  const file = uploads.find((upload) => upload.id === document.referenceId);
                  const replaced = document.supersedesReferenceId
                    ? uploads.find((upload) => upload.id === document.supersedesReferenceId)
                    : null;
                  return (
                    <li key={document.id}>
                      <div>
                        <strong>{file?.fileName ?? '(file removed)'}</strong>
                        {/*
                          Nothing but the PM can tell a new version from new material. It decides
                          whether the document is compared against a predecessor or read as new, so
                          the PM settles it here.
                        */}
                        <select
                          value={document.supersedesReferenceId ?? ''}
                          disabled={!canWrite || setChangeDocumentReplaces.isPending}
                          onChange={(event) =>
                            setChangeDocumentReplaces.mutate({
                              referenceId: document.referenceId,
                              replaces: event.target.value || null,
                            })
                          }
                        >
                          <option value="">New document — nothing to compare against</option>
                          {uploads
                            .filter((upload) => upload.id !== document.referenceId)
                            .map((upload) => (
                              <option key={upload.id} value={upload.id}>
                                New version of {upload.fileName}
                                {upload.superseded ? ' (replaced)' : ''}
                              </option>
                            ))}
                        </select>
                        <small>
                          {replaced
                            ? `Compared against ${replaced.fileName} — the analysis reports what differs`
                            : 'Read as new material, and checked against everything already on file'}
                          {file && !file.textAvailable ? ' · no text could be read from it' : ''}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="library-delete"
                        title={`Delete ${file?.fileName ?? 'this document'} — the file is removed, not just unlinked`}
                        disabled={!canWrite || removeChangeDocument.isPending}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete ${file?.fileName ?? 'this document'}?\n\nThe file and the text read from it are removed for good. Upload it again if you need it back.`,
                            )
                          ) {
                            removeChangeDocument.mutate(document.referenceId);
                          }
                        }}
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <label className={`drop-zone change-drop${canWrite ? '' : ' is-locked'}`}>
              <span>↑</span>
              <strong>{uploadChangeDocument.isPending ? 'Uploading…' : 'Drop the changed documents here, or browse'}</strong>
              <p>
                Up to {MAX_CHANGE_DOCUMENTS} documents, {MAX_CHANGE_UPLOAD_MB} MB each · PDF, Word, Excel, PowerPoint or
                TXT
              </p>
              <small>
                {openChange.documents.length}/{MAX_CHANGE_DOCUMENTS} attached · each one is proposed as a new version or
                as new material, and you can correct it above
              </small>
              <input
                type="file"
                accept={UPLOAD_ACCEPT}
                multiple
                disabled={!canWrite || uploadChangeDocument.isPending}
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])];
                  event.target.value = '';
                  const room = MAX_CHANGE_DOCUMENTS - openChange.documents.length;
                  if (files.length > room) {
                    notify({
                      title: `Room for ${room} more document${room === 1 ? '' : 's'}`,
                      detail: `A change carries at most ${MAX_CHANGE_DOCUMENTS}. Remove one, or upload fewer at a time.`,
                    });
                    return;
                  }
                  // Sequentially: each upload looks at what is already on file to propose the version
                  // relationship, so two in flight at once would read a stale list.
                  void files.reduce<Promise<void>>(
                    (queue, file) =>
                      queue.then(async () => {
                        await uploadChangeDocument.mutateAsync(file).catch(() => undefined);
                      }),
                    Promise.resolve(),
                  );
                }}
              />
            </label>
          </div>

          {openChange.status === 'ANALYZED' && (
            <p className="doc-note">
              This change has been analysed. Editing it clears that reading — the impact would otherwise describe a
              different change from the one recorded.
            </p>
          )}

          <div className="modal-actions">
            {openChange.status === 'ANALYZED' && (
              <button className="secondary" onClick={() => setEditing(false)}>
                View change impact →
              </button>
            )}
            <button
              className="primary"
              onClick={() => analyzeChange.mutate()}
              disabled={!canWrite || analyzeChange.isPending}
              title="Measure what changed against the plan already on file"
            >
              {analyzeChange.isPending ? '✦ Analyzing the change…' : '✦ Analyze the change'}
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
