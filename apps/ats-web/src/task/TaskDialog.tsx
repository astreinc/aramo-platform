import { useState } from 'react';
import {
  Combobox,
  Dialog,
  FormField,
  InlineAlert,
  type ComboboxItem,
} from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import { createTask, updateTask } from './task-api';
import { isAssigneeError, taskMutateErrorMessage } from './error-messages';
import { PRIORITY_LABELS, STATUS_LABELS, TYPE_LABELS } from './task-vocab';
import {
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
  TASK_TYPE_VALUES,
  type TaskOwnerType,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
  type TaskView,
} from './types';

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
  // §5 Auth-Hardening D4 — the assignable roster (minimal {user_id,
  // display_name}) from the recruiter-scoped assignable endpoint. Every
  // work-assigning role holds the read scope, so the picker always has a real
  // roster — no admin-gated 403-fallback.
  readonly roster: readonly AssignableUser[];
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
  const [type, setType] = useState<TaskType | ''>(initial?.type ?? '');
  const [priority, setPriority] = useState<TaskPriority | ''>(initial?.priority ?? '');
  const [assigneeId, setAssigneeId] = useState<string | null>(
    initial?.assignee_id ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);

  const rosterItems: ComboboxItem[] = roster.map((u) => ({
    value: u.user_id,
    label: u.display_name ?? u.user_id,
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
          ...(type === '' ? {} : { type }),
          ...(priority === '' ? {} : { priority }),
        });
      } else {
        saved = await updateTask(initial!.id, {
          title: title.trim(),
          description: description.trim() === '' ? null : description.trim(),
          due_date: dueDate === '' ? null : dueDate,
          status,
          assignee_id: assigneeId,
          type: type === '' ? null : type,
          priority: priority === '' ? null : priority,
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
      <FormField label="Type">
        <select
          aria-label="Type"
          value={type}
          onChange={(e) => setType(e.target.value as TaskType | '')}
        >
          <option value="">No type</option>
          {TASK_TYPE_VALUES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Priority">
        <select
          aria-label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskPriority | '')}
        >
          <option value="">No priority</option>
          {TASK_PRIORITY_VALUES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </FormField>
      {mode === 'edit' ? (
        <FormField label="Status">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
          >
            {TASK_STATUS_VALUES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </FormField>
      ) : null}
      <FormField label="Assignee">
        <Combobox
          items={rosterItems}
          value={assigneeId}
          onSelect={(item) => setAssigneeId(item.value)}
          placeholder="Assign to a user…"
          emptyMessage="No assignable users found."
          ariaLabel="Assignee"
          testId="task-assignee"
        />
        {assigneeError !== null ? (
          <InlineAlert variant="error">{assigneeError}</InlineAlert>
        ) : null}
      </FormField>
    </Dialog>
  );
}
