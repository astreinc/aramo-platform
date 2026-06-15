import { Icons } from '../../ui';

// BulkBar — fixed action bar shown when ≥1 talent is selected. Feature-local.
// Backable actions wire to real mutations; un-backable ones are visibly
// DISABLED with a carry note (never hidden, never faked). Export is a permanent
// DISABLED moat (R7 / DDR §8 — consent-protected, never wired).

interface BulkBarProps {
  readonly count: number;
  readonly busy: boolean;
  readonly onAddToReq: () => void;
  readonly onAssignToMe: () => void;
  readonly canAssign: boolean;
  readonly onClear: () => void;
}

export function BulkBar({
  count,
  busy,
  onAddToReq,
  onAssignToMe,
  canAssign,
  onClear,
}: BulkBarProps) {
  if (count === 0) return null;
  return (
    <div className="rc-bulkbar" role="region" aria-label="Bulk actions">
      <span className="rc-bulkbar__n num">
        {count} <small>selected</small>
      </span>
      <span className="rc-bulkbar__sep" />

      <button type="button" onClick={onAddToReq} disabled={busy}>
        <Icons.IconBriefcase />
        Add to req
      </button>

      <button
        type="button"
        onClick={onAssignToMe}
        disabled={busy || !canAssign}
        title={
          canAssign
            ? 'Set you as owner on the selected talent'
            : 'Needs talent:edit'
        }
      >
        <Icons.IconUserPlus />
        Assign to me
      </button>

      {/* Honest carries — disabled with reason */}
      <button
        type="button"
        disabled
        title="Saved lists aren't granted to recruiters yet (saved-list scope carry)."
      >
        <Icons.IconList />
        Add to list
      </button>
      <button type="button" disabled title="No tag model on the talent record yet (carry).">
        <Icons.IconTag />
        Tag
      </button>
      <button
        type="button"
        disabled
        title="Engagement needs a Core talent overlay; blocked for ATS-only talent (carry)."
      >
        <Icons.IconMessage />
        Start engagement
      </button>

      <span className="rc-bulkbar__sep" />
      <span
        className="rc-bulkbar__ex"
        title="Export is consent-protected and intentionally unavailable (R7 / DDR §8)."
      >
        <Icons.IconShield />
        Export off — consent-protected
      </span>

      <button
        type="button"
        className="rc-bulkbar__x"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <Icons.IconX />
      </button>
    </div>
  );
}
