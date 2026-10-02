import { Button } from '@aramo/fe-foundation';

import { Icons } from '../../ui';

// BulkBar — fixed action bar shown when ≥1 talent is selected. CRM-2: the
// approved bulk bar is exactly "Add to list" + "Add to requisition" (prototype).
// Assign-to-me / Tag / Start-selection / Export were retired from this bar
// (owner_id is provenance, not ownership; the rest are not approved CRM actions).
// "Add to list" is permission-gated on saved-list:edit (CRM-1).

interface BulkBarProps {
  readonly count: number;
  readonly busy: boolean;
  readonly canManageLists: boolean;
  readonly onAddToList: () => void;
  readonly onAddToReq: () => void;
  readonly onClear: () => void;
}

export function BulkBar({
  count,
  busy,
  canManageLists,
  onAddToList,
  onAddToReq,
  onClear,
}: BulkBarProps) {
  if (count === 0) return null;
  return (
    <div className="rc-bulkbar" role="region" aria-label="Bulk actions">
      <span className="rc-bulkbar__n num">
        {count} <small>selected</small>
      </span>
      <span className="rc-bulkbar__sep" />

      {canManageLists ? (
        <Button
          type="button"
          className="rc-bulkbar__primary"
          onClick={onAddToList}
          disabled={busy}
        >
          <Icons.IconList />
          Add to list
        </Button>
      ) : null}

      <Button type="button" onClick={onAddToReq} disabled={busy}>
        <Icons.IconBriefcase />
        Add to requisition
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
