import { Button } from '@aramo/fe-foundation';

import { Icons } from '../../ui';

// Tasks workspace — the fixed bulk-action bar (mockup parity). Complete /
// Reschedule / Snooze are BACKED (status + due_date PATCH). Reassign is DEFERRED
// (needs an assignable-users roster + assign scope) — rendered DISABLED with the
// reason, never faked.

interface TaskBulkBarProps {
  readonly count: number;
  readonly busy: boolean;
  readonly onComplete: () => void;
  readonly onReschedule: () => void;
  readonly onSnooze: () => void;
  readonly onClear: () => void;
}

export function TaskBulkBar({
  count,
  busy,
  onComplete,
  onReschedule,
  onSnooze,
  onClear,
}: TaskBulkBarProps) {
  if (count === 0) return null;
  return (
    <div className="rc-bulkbar" role="region" aria-label="Bulk task actions">
      <span className="rc-bulkbar__n num">
        {count} <small>selected</small>
      </span>
      <span className="rc-bulkbar__sep" />

      <Button type="button" onClick={onComplete} disabled={busy} data-testid="bulk-complete">
        <Icons.IconCheck />
        Complete
      </Button>
      <Button type="button" onClick={onReschedule} disabled={busy} data-testid="bulk-reschedule">
        <Icons.IconClock />
        Reschedule
      </Button>
      <Button type="button" onClick={onSnooze} disabled={busy} data-testid="bulk-snooze">
        <Icons.IconChevronRight />
        Snooze
      </Button>

      {/* Deferred — bulk reassign needs an assignable-users roster + assign
          scope (the carry). Disabled, never faked. */}
      <Button
        type="button"
        disabled
        title="Bulk reassign needs an assignable-users roster + assign scope (carry)."
        data-testid="bulk-reassign"
      >
        <Icons.IconUserPlus />
        Reassign
      </Button>

      <Button unstyled
        type="button"
        className="rc-bulkbar__x"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <Icons.IconX />
      </Button>
    </div>
  );
}
