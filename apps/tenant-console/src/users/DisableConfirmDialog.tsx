import { useState } from 'react';
import { Button } from '@aramo/fe-foundation';
import { Dialog } from '@aramo/fe-foundation';
import { FormField } from '@aramo/fe-foundation';
import { InlineAlert } from '@aramo/fe-foundation';
import { useToast } from '@aramo/fe-foundation';

import { messageForDisableError, type ErrorMessage } from './error-messages';
import type { TenantUserView } from './types';
import { disableTenantUser } from './users-api';

// Settings S5b — disable confirm Dialog.
//
// Wires POST /v1/tenant/users/:user_id/disable. Optional free-text
// `reason` rides the body.
//
// Ruling 1 — disable is one-way from this screen. No tenant-facing
// re-enable endpoint exists yet (only the saga's Cognito-failure
// compensation). The copy is HONEST about this: "Re-enabling isn’t
// yet available from this screen." A re-enable backend PR is an
// S5b-adjacent follow-up.
//
// Idempotency: the BE distinguishes `changed: true` (first disable) from
// `already_disabled: true` (no-op). Both surface as success here — the
// admin's intent ("this user is disabled") is achieved either way.

interface DisableConfirmDialogProps {
  user: TenantUserView | null;
  onOpenChange: (open: boolean) => void;
  onDisabled: (userId: string) => void;
  // Test seam.
  disableFn?: typeof disableTenantUser;
}

export function DisableConfirmDialog({
  user,
  onOpenChange,
  onDisabled,
  disableFn,
}: DisableConfirmDialogProps) {
  const disable = disableFn ?? disableTenantUser;
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const reset = () => {
    setReason('');
    setError(null);
    setSaving(false);
  };

  const onConfirm = async () => {
    if (user === null) return;
    setError(null);
    setSaving(true);
    try {
      await disable({
        userId: user.user_id,
        reason: reason.trim() === '' ? null : reason.trim(),
      });
      toast.show(`Disabled ${user.email}.`);
      onDisabled(user.user_id);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForDisableError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Disable this user?"
      description={
        user !== null
          ? `${user.display_name ?? user.email} will lose access.`
          : undefined
      }
      size="sm"
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
            onClick={onConfirm}
            disabled={saving || user === null}
            data-testid="disable-confirm"
          >
            {saving ? 'Disabling…' : 'Disable user'}
          </Button>
        </>
      }
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
      <InlineAlert variant="error">
        Disabling removes their access. Re-enabling isn’t yet available from
        this screen.
      </InlineAlert>
      <FormField
        label={<label htmlFor="disable-reason">Reason (optional)</label>}
        helper="Recorded in the audit log; visible only to admins."
      >
        <input
          id="disable-reason"
          type="text"
          className="tc-input"
          value={reason}
          disabled={saving}
          onChange={(ev) => setReason(ev.target.value)}
        />
      </FormField>
    </Dialog>
  );
}
