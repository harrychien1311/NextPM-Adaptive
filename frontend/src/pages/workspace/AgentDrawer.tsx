import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { agentApi } from '../../api/endpoints';

const QUICK_PROMPTS = ['Explain the recommended governance model', 'Show missing inputs', 'Generate the Risk Plan'];

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
  const [question, setQuestion] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['agent', projectId],
    queryFn: () => agentApi.messages(projectId),
    enabled: open,
  });

  const ask = useMutation({
    mutationFn: (text: string) => agentApi.ask(projectId, text),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent', projectId] }),
  });

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [data?.messages.length, ask.isPending]);

  return (
    <aside className={`agent-drawer${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="drawer-head">
        <div className="agent-orb">✦</div>
        <div>
          <strong>Planning Agent</strong>
          <span>Verified inputs + AI recommendation</span>
        </div>
        <button onClick={onClose}>×</button>
      </div>
      <div className="guardrail">
        AI verifies, recommends and drafts. The PM confirms the approach and approves every baseline output.
      </div>

      <div className="conversation" ref={scroller}>
        {(data?.messages ?? []).map((message) =>
          message.role === 'AGENT' ? (
            <div className="agent-message" key={message.id}>
              <span>✦</span>
              <div>
                <p>{message.content}</p>
                {message.meta ? (
                  <small>
                    {String((message.meta as Record<string, unknown>).verifiedInputs ?? 0)} verified inputs ·{' '}
                    {String((message.meta as Record<string, unknown>).missingValues ?? 0)} missing values · no decision
                    applied
                  </small>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="user-message" key={message.id}>
              <span>{message.content}</span>
            </div>
          ),
        )}
        {ask.isPending && (
          <div className="agent-message">
            <span>✦</span>
            <div>
              <p>
                <span className="inline-spinner" /> Checking verified inputs and the AI recommendation…
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="quick-prompts">
        {QUICK_PROMPTS.map((prompt) => (
          <button key={prompt} onClick={() => setQuestion(prompt)}>
            {prompt}
          </button>
        ))}
      </div>

      <form
        className="agent-input"
        onSubmit={(event) => {
          event.preventDefault();
          if (!question.trim()) return;
          ask.mutate(question.trim());
          setQuestion('');
        }}
      >
        <input
          placeholder="Ask about this project…"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button>↑</button>
      </form>

      <div className="agent-actions">
        <span>Copilot actions</span>
        <div>
          <b>Verify fields</b>
          <b>Get recommendation</b>
          <b>Generate draft</b>
          <b>Route PM approval</b>
        </div>
      </div>
    </aside>
  );
}
