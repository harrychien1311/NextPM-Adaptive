import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/Toast';
import { AgentMessageText } from './AgentMessageText';

const QUICK_PROMPTS = ['Explain the recommended governance model', 'Show missing inputs', 'What does the Risk Plan say?'];

/** Docked (the original side panel), maximised, or free-floating after being dragged. */
type PanelMode = 'docked' | 'full';

export function AgentDrawer({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const notify = useToast();
  const [question, setQuestion] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>('docked');
  const [showSessions, setShowSessions] = useState(false);
  /** Non-null once the PM has dragged the panel; null means "sit where the CSS puts it". */
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const sessions = useQuery({
    queryKey: ['agent-sessions', projectId],
    queryFn: () => agentApi.sessions(projectId),
    enabled: open,
  });

  const messages = useQuery({
    queryKey: ['agent-messages', projectId, sessionId],
    queryFn: () => agentApi.messages(projectId, sessionId!),
    enabled: open && Boolean(sessionId),
  });

  const refreshSessions = () => queryClient.invalidateQueries({ queryKey: ['agent-sessions', projectId] });

  const newSession = useMutation({
    mutationFn: () => agentApi.createSession(projectId),
    onSuccess: (session) => {
      refreshSessions();
      setSessionId(session.id);
      setShowSessions(false);
    },
  });

  const ask = useMutation({
    mutationFn: (text: string) => agentApi.ask(projectId, sessionId!, text),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-messages', projectId, sessionId] });
      refreshSessions();
    },
    onError: (error) =>
      notify({ title: 'The agent could not reply', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const removeSession = useMutation({
    mutationFn: (id: string) => agentApi.deleteSession(projectId, id),
    onSuccess: (_result, id) => {
      refreshSessions();
      if (id === sessionId) setSessionId(null);
    },
  });

  // Open the most recent thread, or start one if this project has never been chatted about.
  useEffect(() => {
    if (!open || sessionId || !sessions.data) return;
    const latest = sessions.data.sessions[0];
    if (latest) setSessionId(latest.id);
    else if (!newSession.isPending) newSession.mutate();
  }, [open, sessionId, sessions.data]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.data?.messages.length, ask.isPending]);

  /**
   * Drag by the header. Listeners are attached here rather than in an effect so a click on a
   * toolbar button never begins a drag — that used to leave an inline transform behind, and since
   * the drawer closes with `right: -410px`, a leftward transform dragged it straight back into
   * view. The × then looked broken.
   */
  const startDrag = (event: React.MouseEvent) => {
    if (mode === 'full') return; // maximised fills the screen; nothing to drag
    if ((event.target as HTMLElement).closest('button')) return; // let the toolbar work
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const origin = offset ?? { x: 0, y: 0 };

    const move = (moveEvent: MouseEvent) => {
      // Keep at least a header's worth of the panel on screen, so it can always be grabbed back.
      const x = origin.x + (moveEvent.clientX - startX);
      const y = origin.y + (moveEvent.clientY - startY);
      setOffset({
        x: Math.min(Math.max(x, -window.innerWidth + 220), 40),
        y: Math.min(Math.max(y, 0), window.innerHeight - 80),
      });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const submit = (text: string) => {
    if (!text.trim() || !sessionId) return;
    ask.mutate(text.trim());
    setQuestion('');
  };

  const list = messages.data?.messages ?? [];

  return (
    <aside
      /*
       * `full` and `floating` describe how the panel sits *while open*, so they are only ever put
       * on the element while it is open. The closed drawer is therefore always a plain
       * `.agent-drawer`, which parks itself off-screen with `right: -410px`.
       *
       * This is deliberately structural rather than a matter of writing each CSS rule carefully:
       * the same bug appeared twice — once from an inline transform, once from `inset` in the
       * maximise rule — and both times something left over from the open state held the panel on
       * screen. Keeping the state out of the DOM removes the whole family of failures.
       */
      className={`agent-drawer${open ? ` open${mode === 'full' ? ' full' : ''}${offset ? ' floating' : ''}` : ''}`}
      aria-hidden={!open}
      style={open && offset && mode !== 'full' ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    >
      <div className="drawer-head" onMouseDown={startDrag} title="Drag to move">
        <div className="agent-orb">✦</div>
        <div>
          <strong>Planning Agent</strong>
          <span>{sessions.data?.sessions.find((s) => s.id === sessionId)?.title ?? 'New chat'}</span>
        </div>
        <div className="drawer-tools">
          <button onClick={() => setShowSessions((value) => !value)} title="Chat history" aria-label="Chat history">
            ☰
          </button>
          <button onClick={() => newSession.mutate()} title="New chat" aria-label="New chat">
            ＋
          </button>
          <button
            onClick={() => setMode(mode === 'full' ? 'docked' : 'full')}
            title={mode === 'full' ? 'Restore' : 'Maximise'}
            aria-label={mode === 'full' ? 'Restore' : 'Maximise'}
          >
            {mode === 'full' ? '⤡' : '⤢'}
          </button>
          {offset && mode !== 'full' && (
            <button onClick={() => setOffset(null)} title="Snap back to the edge" aria-label="Snap back">
              ⟲
            </button>
          )}
          <button onClick={onClose} title="Close" aria-label="Close">
            ×
          </button>
        </div>
      </div>

      <div className="drawer-body">
        {showSessions && (
          <div className="session-list">
            <div className="session-list-head">
              <strong>Chat history</strong>
              <button onClick={() => newSession.mutate()}>＋ New</button>
            </div>
            {(sessions.data?.sessions ?? []).map((session) => (
              <div className={`session-item${session.id === sessionId ? ' active' : ''}`} key={session.id}>
                <button
                  onClick={() => {
                    setSessionId(session.id);
                    setShowSessions(false);
                  }}
                >
                  <b>{session.title}</b>
                  <small>
                    {session._count.messages} message{session._count.messages === 1 ? '' : 's'} ·{' '}
                    {new Date(session.updatedAt).toLocaleDateString()}
                  </small>
                </button>
                <i
                  role="button"
                  tabIndex={0}
                  title="Delete chat"
                  onClick={() => {
                    if (window.confirm(`Delete the chat "${session.title}"?`)) removeSession.mutate(session.id);
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && removeSession.mutate(session.id)}
                >
                  ×
                </i>
              </div>
            ))}
            {sessions.data?.sessions.length === 0 && <p className="session-empty">No chats yet.</p>}
          </div>
        )}

        <div className="conversation-wrap">
          <div className="guardrail">
            AI verifies, recommends and drafts. The PM confirms the approach and approves every baseline output.
          </div>

          <div className="conversation" ref={scroller}>
            {list.map((message) =>
              message.role === 'AGENT' ? (
                <div className="agent-message" key={message.id}>
                  <span>✦</span>
                  <div>
                    <AgentMessageText content={message.content} />
                  </div>
                </div>
              ) : (
                <div className="user-message" key={message.id}>
                  <span>{message.content}</span>
                </div>
              ),
            )}
            {!list.length && !messages.isLoading && (
              <div className="agent-message">
                <span>✦</span>
                <div>
                  <AgentMessageText content="Ask me about this project — the verified inputs, the governance model, or any planning document that has been generated." />
                </div>
              </div>
            )}
            {ask.isPending && (
              <div className="agent-message">
                <span>✦</span>
                <div>
                  <p>
                    <span className="inline-spinner" /> Reading the project…
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="quick-prompts">
            {QUICK_PROMPTS.map((prompt) => (
              <button key={prompt} onClick={() => submit(prompt)} disabled={ask.isPending}>
                {prompt}
              </button>
            ))}
          </div>

          <form
            className="agent-input"
            onSubmit={(event) => {
              event.preventDefault();
              submit(question);
            }}
          >
            <input
              placeholder="Ask about this project…"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              disabled={ask.isPending || !sessionId}
            />
            <button disabled={ask.isPending || !sessionId}>↑</button>
          </form>
        </div>
      </div>
    </aside>
  );
}
