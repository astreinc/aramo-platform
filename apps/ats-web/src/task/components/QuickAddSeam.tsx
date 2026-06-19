import { Icons } from '../../ui';
import { PRIORITY_LABELS, TYPE_LABELS } from '../task-vocab';
import { TASK_PRIORITY_VALUES, TASK_TYPE_VALUES } from '../types';

// Tasks workspace — the quick-add bar. A task is polymorphic on a REQUIRED
// owner (talent_record / requisition / company / contact); an owner-less task
// is NOT backed, and the directive's reconciliation does not list /tasks-origin
// creation among the backed surfaces (the owner-picker create is a filed carry).
// So the bar renders for parity but is a RESERVED, DISABLED seam — the Type/
// Priority/Due selects show the real closed vocab, and the honest note routes
// creation to a record's Tasks tab (the backed owner-context path). No fake
// owner-less create.

export function QuickAddSeam() {
  return (
    <div className="rc-quickadd rc-quickadd--seam" data-testid="quickadd-seam" aria-disabled="true">
      <span className="rc-quickadd__plus" aria-hidden="true">
        <Icons.IconPlus />
      </span>
      <input
        className="rc-quickadd__title"
        placeholder="Create a task from a talent, requisition, or company record…"
        disabled
        aria-label="Add a task (disabled — create from a record)"
      />
      <select disabled aria-label="Type" defaultValue="">
        <option value="">Type</option>
        {TASK_TYPE_VALUES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      <select disabled aria-label="Priority" defaultValue="">
        <option value="">Priority</option>
        {TASK_PRIORITY_VALUES.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p]}
          </option>
        ))}
      </select>
      <span className="rc-quickadd__note">
        <Icons.IconInfo />
        New tasks are created from a record’s Tasks tab.
      </span>
    </div>
  );
}
