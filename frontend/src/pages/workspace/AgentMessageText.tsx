import { Fragment, type ReactNode } from 'react';

/**
 * Renders the agent's reply.
 *
 * The model returns prose, not JSON — but it returns *markdown* prose, and dropping that into a
 * single `<p>` collapses every line break and prints the `**` and `- ` characters literally,
 * which is what made replies unreadable.
 *
 * This understands only the subset the chat system prompt in `ai/provider.ts` promises to stay
 * within: blank-line paragraphs, `- ` / `1. ` lists, `**bold**` and `` `code` ``. It is not a
 * general markdown parser, and it is not meant to become one — the prompt and this renderer are
 * two halves of one contract. Everything is rendered as React text nodes, never as raw HTML.
 */

const INLINE_SPLIT = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** `**bold**` and `` `code` `` inside one line. */
function inline(text: string): ReactNode[] {
  return text.split(INLINE_SPLIT).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

const BULLET = /^\s*[-*]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export function AgentMessageText({ content }: { content: string }) {
  // Blank lines separate blocks; a run of list lines is one block even without blank lines
  // around it, because models rarely put them there.
  const blocks = content
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return (
    <div className="agent-rich">
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);

        if (lines.length && lines.every((line) => BULLET.test(line))) {
          return (
            <ul key={blockIndex}>
              {lines.map((line, index) => (
                <li key={index}>{inline(line.replace(BULLET, ''))}</li>
              ))}
            </ul>
          );
        }

        if (lines.length && lines.every((line) => NUMBERED.test(line))) {
          return (
            <ol key={blockIndex}>
              {lines.map((line, index) => (
                <li key={index}>{inline(line.replace(NUMBERED, ''))}</li>
              ))}
            </ol>
          );
        }

        // A plain paragraph: keep single line breaks the model intended.
        return (
          <p key={blockIndex}>
            {lines.map((line, index) => (
              <Fragment key={index}>
                {index > 0 && <br />}
                {inline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
