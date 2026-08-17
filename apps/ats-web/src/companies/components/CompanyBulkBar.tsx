import { Icons } from '../../ui';

// CompanyBulkBar — fixed action bar shown when ≥1 account is selected (mirrors
// the talent BulkBar). The ONE backed action is "Assign to me" (PATCH
// /v1/companies/:id { owner_id }, company:edit). Un-backed mockup actions (Add
// to list / Tag) are visibly DISABLED with a carry reason — never hidden, never
// faked. Export is shown as a permanent disabled note (matches the mockup's
// greyed "Export account list").

interface CompanyBulkBarProps {
  readonly count: number;
  readonly busy: boolean;
  readonly canAssign: boolean;
  readonly onAssignToMe: () => void;
  readonly onClear: () => void;
}

export function CompanyBulkBar({
  count,
  busy,
  canAssign,
  onAssignToMe,
  onClear,
}: CompanyBulkBarProps) {
  if (count === 0) return null;
  return (
    <div className="rc-bulkbar" role="region" aria-label="Bulk actions">
      <span className="rc-bulkbar__n num">
        {count} <small>selected</small>
      </span>
      <span className="rc-bulkbar__sep" />

      {/* T10-B3/F-012 — permission-driven: HIDE when the actor lacks the write
          scope (never a disabled control naming the scope). Disabled only while
          a submit is in flight. */}
      {canAssign ? (
        <button
          type="button"
          onClick={onAssignToMe}
          disabled={busy}
          title="Set you as owner on the selected accounts"
        >
          <Icons.IconUserPlus />
          Assign to me
        </button>
      ) : null}

      {/* Honest carries — disabled with reason */}
      <button
        type="button"
        disabled
        title="Saved lists aren't granted to recruiters yet (saved-list scope carry)."
      >
        <Icons.IconList />
        Add to list
      </button>
      <button
        type="button"
        disabled
        title="Account tags aren't editable in bulk yet (carry)."
      >
        <Icons.IconTag />
        Tag
      </button>

      <span className="rc-bulkbar__sep" />
      <span
        className="rc-bulkbar__ex"
        title="Bulk account export isn't available in this prototype."
      >
        <Icons.IconShield />
        Export off
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
