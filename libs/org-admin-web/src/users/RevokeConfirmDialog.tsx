import { useState } from 'react';
import {
  Button,
  Dialog,
  InlineAlert,
  useToast,
} from '@aramo/fe-foundation';

import { messageForLifecycleActionError, type ErrorMessage } from './error-messages';
import type { TenantUserView } from './types';
import { revokeTenantInvitation } from './users-api';

// Invite-S3 (§4.2) — revoke confirm Dialog (destructive; mirrors
// DisableConfirmDialog). Wires POST /v1/tenant/users/:user_id/revoke. A
// revoked invite leaves the pending set and projects to INACTIVE (the
// membership is soft-disabled) — it can be revived via Enable + Resend.

interface RevokeConfirmDialogProps {
  user: TenantUserView | null;
  onOpenChange: (open: boolean) => void;
  onRevoked: (userId: string) => void;
  // Test seam.
  revokeFn?: typeof revokeTenantInvitation;
}

export function RevokeConfirmDialog({
  user,
  onOpenChange,
  onRevoked,
  revokeFn,
}: RevokeConfirmDialogProps) {
  const revoke = revokeFn ?? revokeTenantInvitation;
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const reset = () => {
    setError(null);
    setSaving(false);
  };

  const onConfirm = async () => {
    if (user === null) return;
    setError(null);
    setSaving(true);
    try {
      await revoke(user.user_id);
      toast.show(`Invitation for ${user.email} revoked.`);
      onRevoked(user.user_id);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForLifecycleActionError(err));
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
      title="Revoke this invitation?"
      description={
        user !== null
          ? `${user.display_name ?? user.email} will no longer be able to accept and join.`
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
            data-testid="revoke-confirm"
          >
            {saving ? 'Revoking…' : 'Revoke invitation'}
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
        The current invitation link stops working. You can re-enable and resend
        a fresh invitation later if needed.
      </InlineAlert>
    </Dialog>
  );
}
