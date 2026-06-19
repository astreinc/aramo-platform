import { useState } from 'react';
import { Button } from '@aramo/fe-foundation';
import { Dialog } from '@aramo/fe-foundation';
import { FormField } from '@aramo/fe-foundation';
import { InlineAlert } from '@aramo/fe-foundation';
import { useToast } from '@aramo/fe-foundation';

import {
  messageForAddEdgeError,
  type ErrorMessage,
} from './error-messages';
import type { AddEdgeResponse, UserRosterState } from './types';
import { addManagementEdge } from './edges-api';

// Settings S5c-1 — AddEdgeDialog.
//
// PL-94 §2 ruling 1 — PICKER = native <select>. The user roster is
// bounded; native <select> ships keyboard nav + type-ahead + a11y for
// free; no new dep. The Combobox stays S5c-2's deliverable.
//
// PL-94 §2 ruling 6 — PICKER-SOURCE 403 FALLBACK. When the roster
// probe returned `forbidden`, this Dialog renders raw-UUID text inputs
// instead of the selects + a one-line helper note. NEVER blocks the
// editor; the BE bad-UUID rejection is the floor.
//
// PL-94 §2 ruling 4 — DUPLICATE = SILENT SUCCESS. The BE returns the
// existing edge with no event; the Dialog refreshes the tree and
// shows a generic "Edge saved" toast — no special-cased "already
// exists" message.

interface AddEdgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roster: UserRosterState;
  onAdded: (result: AddEdgeResponse) => void;
  // Test seam.
  addFn?: typeof addManagementEdge;
}

function displayFor(u: {
  user_id: string;
  display_name: string | null;
  email: string;
}): string {
  return u.display_name !== null && u.display_name.length > 0
    ? `${u.display_name} (${u.email})`
    : u.email;
}

export function AddEdgeDialog({
  open,
  onOpenChange,
  roster,
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

  // Sort the roster alphabetically when present — names first, falling
  // back to email. The 403 fallback path renders bare inputs instead.
  const sortedUsers =
    roster.state === 'ready'
      ? [...roster.users].sort((a, b) => {
          const an = a.display_name ?? a.email;
          const bn = b.display_name ?? b.email;
          return an.localeCompare(bn);
        })
      : [];

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
        {roster.state === 'forbidden' && (
          <InlineAlert variant="error">
            User roster isn’t available to your role. Paste user IDs
            instead — the server validates them on save.
          </InlineAlert>
        )}
        {roster.state === 'ready' ? (
          <>
            <FormField
              label={<label htmlFor="add-edge-manager">Manager</label>}
            >
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
            <FormField
              label={<label htmlFor="add-edge-report">Report</label>}
            >
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
          </>
        ) : (
          <>
            <FormField
              label={<label htmlFor="add-edge-manager-uuid">Manager user ID</label>}
              helper="UUID from your records."
            >
              <input
                id="add-edge-manager-uuid"
                type="text"
                className="rc-input"
                value={manager}
                disabled={saving}
                onChange={(ev) => setManager(ev.target.value)}
                data-testid="add-edge-manager-input"
              />
            </FormField>
            <FormField
              label={<label htmlFor="add-edge-report-uuid">Report user ID</label>}
              helper="UUID from your records."
            >
              <input
                id="add-edge-report-uuid"
                type="text"
                className="rc-input"
                value={report}
                disabled={saving}
                onChange={(ev) => setReport(ev.target.value)}
                data-testid="add-edge-report-input"
              />
            </FormField>
          </>
        )}
      </form>
    </Dialog>
  );
}
