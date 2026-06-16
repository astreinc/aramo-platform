import type { ReactNode } from 'react';

import { IconAlert, IconClock, IconReply, IconTasks } from './icons';

export type ActionKind = 'due' | 'reply' | 'overdue' | 'task';

interface ActionItemProps {
  readonly kind: ActionKind;
  readonly title: ReactNode;
  readonly context?: ReactNode;
  readonly time?: ReactNode;
  /** The single affordance (e.g. "Open", "Reply", "Do it"). */
  readonly action?: ReactNode;
}

const ICON: Record<ActionKind, ReactNode> = {
  due: <IconClock />,
  reply: <IconReply />,
  overdue: <IconAlert />,
  task: <IconTasks />,
};

// A typed "Needs you today" row. PER LEAD GAP #7 the My-desk list that uses
// these is a CLIENT-SIDE aggregation over real data (tasks + responded
// engagements + overdue follow-ups) — this atom just renders one entry.
export function ActionItem({
  kind,
  title,
  context,
  time,
  action,
}: ActionItemProps) {
  return (
    <div className="rc-action">
      <div className={`rc-action__ic rc-action__ic--${kind}`} aria-hidden="true">
        {ICON[kind]}
      </div>
      <div className="rc-action__body">
        <div className="rc-action__t">{title}</div>
        {context != null ? <div className="rc-action__c">{context}</div> : null}
      </div>
      {time != null ? <span className="rc-action__when">{time}</span> : null}
      {action}
    </div>
  );
}
