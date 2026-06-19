import type { ReactNode } from 'react';

export interface ActivityFeedItem {
  readonly id: string;
  /** The event line (may include emphasised <b> spans via ReactNode). */
  readonly text: ReactNode;
  readonly when: ReactNode;
}

interface ActivityFeedProps {
  readonly items: readonly ActivityFeedItem[];
}

// A timeline feed — connected dots down the left rail. Read-only display;
// the data is real ActivityView rows resolved at the surface.
export function ActivityFeed({ items }: ActivityFeedProps) {
  return (
    <ol className="rc-feed">
      {items.map((it) => (
        <li key={it.id} className="rc-feed__ev">
          <div className="rc-feed__t">{it.text}</div>
          <div className="rc-feed__when">{it.when}</div>
        </li>
      ))}
    </ol>
  );
}
