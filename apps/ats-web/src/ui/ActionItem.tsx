import type { ReactNode } from 'react';
import {
  IconAlert,
  IconBell,
  IconClock,
  IconReply,
  IconShield,
  IconTasks,
  IconUser,
} from '@aramo/fe-foundation';

export type ActionKind =
  | 'due'
  | 'reply'
  | 'overdue'
  | 'task'
  | 'followup'
  | 'interview'
  | 'consent';

// Priority is a TASK ORDINAL (the BE task.priority field) — never a computed
// verdict about a person (R10-clean). The desk surfaces it as an urgency
// label only.
export type ActionPriority = 'high' | 'med' | 'low';

interface ActionItemProps {
  readonly kind: ActionKind;
  readonly title: ReactNode;
  readonly context?: ReactNode;
  readonly time?: ReactNode;
  /** Task-ordinal urgency label (Now/Soon/Later) — rendered inline by the title. */
  readonly priority?: ActionPriority;
  /** Contract-backed status chips (e.g. an "Overdue" or "Consent" badge). */
  readonly badges?: ReactNode;
  /** The single affordance (e.g. "Open", "Reply", "Refresh"). */
  readonly action?: ReactNode;
}

const ICON: Record<ActionKind, ReactNode> = {
  due: <IconClock />,
  reply: <IconReply />,
  overdue: <IconAlert />,
  task: <IconTasks />,
  followup: <IconBell />,
  interview: <IconUser />,
  consent: <IconShield />,
};

const PRIORITY_LABEL: Record<ActionPriority, string> = {
  high: 'Now',
  med: 'Soon',
  low: 'Later',
};

// A typed "Needs you" row. PER LEAD GAP #7 the My-desk list that uses these is
// a CLIENT-SIDE aggregation over the principal's REAL open tasks (assignee=me,
// server-scoped) — this atom just renders one entry. No fabricated source: the
// kind, priority and badges all project task fields the BE actually returns.
export function ActionItem({
  kind,
  title,
  context,
  time,
  priority,
  badges,
  action,
}: ActionItemProps) {
  return (
    <div className="rc-action">
      <div className={`rc-action__ic rc-action__ic--${kind}`} aria-hidden="true">
        {ICON[kind]}
      </div>
      <div className="rc-action__body">
        <div className="rc-action__t">
          {title}
          {priority != null ? (
            <span className={`rc-pri rc-pri--${priority}`}>
              {PRIORITY_LABEL[priority]}
            </span>
          ) : null}
          {badges}
        </div>
        {context != null ? <div className="rc-action__c">{context}</div> : null}
      </div>
      {time != null ? <span className="rc-action__when">{time}</span> : null}
      {action}
    </div>
  );
}
