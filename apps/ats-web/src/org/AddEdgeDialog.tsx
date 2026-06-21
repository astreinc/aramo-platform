import { useState } from 'react';
import { Button } from '@aramo/fe-foundation';
import { Dialog } from '@aramo/fe-foundation';
import { FormField } from '@aramo/fe-foundation';
import { InlineAlert } from '@aramo/fe-foundation';
import { useToast } from '@aramo/fe-foundation';

import type { AssignableUser } from '../users/users-api';

import {
  messageForAddEdgeError,
  type ErrorMessage,
} from './error-messages';
import type { AddEdgeResponse } from './types';
import { addManagementEdge } from './edges-api';

// Settings S5c-1 — AddEdgeDialog.
//
// PL-94 §2 ruling 1 — PICKER = native <select>. The user roster is
// bounded; native <select> ships keyboard nav + type-ahead + a11y for free.
//
// §5 Auth-Hardening D4c — the picker source is the assignable endpoint (active
// roster). Every work-assigning role holds the scope, so the picker always
// loads — the 403→raw-UUID fallback is GONE.
//
// PL-94 §2 ruling 4 — DUPLICATE = SILENT SUCCESS. The BE returns the
// existing edge with no event; the Dialog refreshes the tree and
// shows a generic "Edge saved" toast — no special-cased "already
// exists" message.

interface AddEdgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: readonly AssignableUser[];
  onAdded: (result: AddEdgeResponse) => void;
  // Test seam.
  addFn?: typeof addManagementEdge;
}

function displayFor(u: AssignableUser): string {
  return u.display_name !== null && u.display_name.length > 0
    ? u.display_name
    : u.user_id;
}

export function AddEdgeDialog({
  open,
  onOpenChange,
  users,
  onAdded,
  addFn,
}: AddEdgeDialogProps) {
  const add = addFn ?? addManagementEdge;
  const toast = useToast();

  const [manager, setManager] = useState('');
  const [report, setReport] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const reset = () => {
    setManager('');
    setReport('');
    setError(null);
    setSaving(false);
  };

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const result = await add({
        manager_user_id: manager.trim(),
        report_user_id: report.trim(),
      });
      toast.show('Edge saved.');
      onAdded(result);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForAddEdgeError(err));
    } finally {
      setSaving(false);
    }
  };

  const submittable =
    !saving && manager.trim().length > 0 && report.trim().length > 0;

  // Alphabetical by display name (id fallback).
  const sortedUsers = [...users].sort((a, b) =>
    (a.display_name ?? a.user_id).localeCompare(b.display_name ?? b.user_id),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Add reporting edge"
      description="Pick the manager and the report. The manager-of relationship is one-directional."
      size="md"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={(ev) => onSubmit(ev)}
            disabled={!submittable}
            data-testid="add-edge-submit"
          >
            {saving ? 'Saving…' : 'Save edge'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={onSubmit}
        aria-label="Add reporting edge"
        data-testid="add-edge-form"
      >
        {error !== null && (
          <InlineAlert variant="error">
            <strong>{error.title}</strong>
            {error.detail !== undefined && (
              <>
                <br />
                {error.detail}
              </>
            )}
          </InlineAlert>
        )}
        <FormField label={<label htmlFor="add-edge-manager">Manager</label>}>
          <select
            id="add-edge-manager"
            className="rc-input"
            value={manager}
            disabled={saving}
            onChange={(ev) => setManager(ev.target.value)}
            data-testid="add-edge-manager-select"
          >
            <option value="">Select a manager…</option>
            {sortedUsers.map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {displayFor(u)}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label={<label htmlFor="add-edge-report">Report</label>}>
          <select
            id="add-edge-report"
            className="rc-input"
            value={report}
            disabled={saving}
            onChange={(ev) => setReport(ev.target.value)}
            data-testid="add-edge-report-select"
          >
            <option value="">Select a report…</option>
            {sortedUsers.map((u) => (
              <option key={u.user_id} value={u.user_id}>
                {displayFor(u)}
              </option>
            ))}
          </select>
        </FormField>
      </form>
    </Dialog>
  );
}
