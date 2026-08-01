import { useState } from 'react';

interface ExpandableTextProps {
  readonly text: string;
  // Character budget before the text is clipped; default suits the compact
  // activity-feed cell.
  readonly limit?: number;
}

// D3 #4 — a text cell that clips past `limit` characters and offers an inline
// More/Less toggle, so a note that overflows the feed is no longer a dead-end
// truncation. Text within budget renders verbatim with no control.
export function ExpandableText({ text, limit = 64 }: ExpandableTextProps) {
  const [expanded, setExpanded] = useState(false);
  if (text.length <= limit) return <>{text}</>;
  const shown = expanded ? text : `${text.slice(0, limit - 1)}…`;
  return (
    <>
      {shown}{' '}
      <button
        type="button"
        className="rc-link-action"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? 'Less' : 'More'}
      </button>
    </>
  );
}
