import { useState } from 'react';
import {
  Combobox,
  Dialog,
  FormField,
  InlineAlert,
  type ComboboxItem,
} from '@aramo/fe-foundation';

import { createTask, updateTask, type RosterState } from './task-api';
import { isAssigneeError, taskMutateErrorMessage } from './error-messages';
import type { TaskOwnerType, TaskStatus, TaskView } from './types';

// Tasks FE — the create/edit Dialog (Ruling 3). title + description? +
// due_date (local date input) + status (local open/done toggle, edit only) +
// assignee (Combobox fed by the tenant-users roster; graceful fallback when
// the roster is admin-gated-away — Ruling 5 + the S5c probe precedent).
//
// owner_type/owner_id come from the in-context entity and are IMMUTABLE — the
// edit form never surfaces them (the BE rejects owner changes).

interface TaskDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: 'create' | 'edit';
  // Create context (required for create; ignored for edit).
  readonly ownerType?: TaskOwnerType;
  readonly ownerId?: string;
  // Edit target (required for edit).
  readonly initial?: TaskView;
  readonly roster: RosterState;
  readonly onSaved: (task: TaskView) => void;
}

export function TaskDialog({
  open,
  onOpenChange,
  mode,
  ownerType,
  ownerId,
  initial,
  roster,
  onSaved,
}: TaskDialogProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [dueDate, setDueDate] = useState(
    initial?.due_date != null ? initial.due_date.slice(0, 10) : '',
  );
  const [status, setStatus] = useState<TaskStatus>(initial?.status ?? 'open');
  const [assigneeId, setAssigneeId] = useState<string | null>(
    initial?.assignee_id ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);

  const rosterItems: ComboboxItem[] = roster.items.map((u) => ({
    value: u.user_id,
    label: u.display_name ?? u.email,
    description: u.display_name !== null ? u.email : undefined,
  }));

  async function submit(): Promise<void> {
    if (title.trim() === '') {
      setError('A title is required.');
      return;
    }
    setBusy(true);
    setError(null);
    setAssigneeError(null);
    try {
      let saved: TaskView;
      if (mode === 'create') {
        saved = await createTask({
          title: title.trim(),
          owner_type: ownerType as TaskOwnerType,
          owner_id: ownerId as string,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...(dueDate === '' ? {} : { due_date: dueDate }),
          ...(assigneeId === null ? {} : { assignee_id: assigneeId }),
        });
      } else {
        saved = await updateTask(initial!.id, {
          title: title.trim(),
          description: description.trim() === '' ? null : description.trim(),
          due_date: dueDate === '' ? null : dueDate,
          status,
          assignee_id: assigneeId,
        });
      }
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      if (isAssigneeError(err)) {
        setAssigneeError('That assignee is unavailable — pick an active user in this tenant.');
      } else {
        setError(taskMutateErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'create' ? 'New task' : 'Edit task'}
      footer={
        <>
          <button type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy} data-testid="task-save">
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      <FormField label="Title">
        <input
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoComplete="off"
        />
      </FormField>
      <FormField label="Description">
        <textarea
          aria-label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </FormField>
      <FormField label="Due date">
        <input
          type="date"
          aria-label="Due date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
        />
      </FormField>
      {mode === 'edit' ? (
        <FormField label="Status">
          <label>
            <input
              type="checkbox"
              aria-label="Done"
              checked={status === 'done'}
              onChange={(e) => setStatus(e.target.checked ? 'done' : 'open')}
            />{' '}
            Done
          </label>
        </FormField>
      ) : null}
      <FormField label="Assignee">
        {roster.available ? (
          <Combobox
            items={rosterItems}
            value={assigneeId}
            onSelect={(item) => setAssigneeId(item.value)}
            placeholder="Assign to a user…"
            emptyMessage="No active users found."
            ariaLabel="Assignee"
            testId="task-assignee"
          />
        ) : (
          <p className="task-dialog__assignee-fallback" data-testid="task-assignee-fallback">
            Assignee selection needs admin access — this task will be unassigned.
          </p>
        )}
        {assigneeError !== null ? (
          <InlineAlert variant="error">{assigneeError}</InlineAlert>
        ) : null}
      </FormField>
    </Dialog>
  );
}
