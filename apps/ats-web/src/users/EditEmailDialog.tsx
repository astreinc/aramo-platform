import { useState } from 'react';
import {
  Button,
  Dialog,
  FormField,
  InlineAlert,
  useToast,
} from '@aramo/fe-foundation';

import { messageForLifecycleActionError, type ErrorMessage } from './error-messages';
import type { TenantUserView } from './types';
import { editTenantUserEmail } from './users-api';

// Invite-S3 (§4.4) — edit-email Dialog (FAILED-only). Wires PATCH
// /v1/tenant/users/:user_id/email. Reached ONLY from a FAILED row's action
// cell — the backend independently enforces the FAILED-only gate (every other
// status → 4xx). In S3 no status is FAILED yet (S4 writes it), so in practice
// this dialog never opens; the path is built + ready for S4. On success the
// email is changed and a fresh invitation is re-issued.

interface EditEmailDialogProps {
  user: TenantUserView | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (userId: string) => void;
  // Test seam.
  editFn?: typeof editTenantUserEmail;
}

export function EditEmailDialog({
  user,
  onOpenChange,
  onSaved,
  editFn,
}: EditEmailDialogProps) {
  const edit = editFn ?? editTenantUserEmail;
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const reset = () => {
    setEmail('');
    setError(null);
    setSaving(false);
  };

  const onConfirm = async () => {
    if (user === null) return;
    setError(null);
    setSaving(true);
    try {
      await edit({ userId: user.user_id, email: email.trim() });
      toast.show(`Updated email and re-sent the invitation.`);
      onSaved(user.user_id);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForLifecycleActionError(err));
    } finally {
      setSaving(false);
    }
  };

  const submittable = !saving && email.trim().length > 0;

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Fix the invitation email"
      description={
        user !== null
          ? `The invitation to ${user.email} couldn’t be delivered. Enter a corrected address to re-send it.`
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
            disabled={!submittable || user === null}
            data-testid="edit-email-confirm"
          >
            {saving ? 'Saving…' : 'Update & resend'}
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
      <FormField label={<label htmlFor="edit-email-input">New email</label>}>
        <input
          id="edit-email-input"
          type="email"
          className="rc-input"
          autoComplete="off"
          value={email}
          disabled={saving}
          onChange={(ev) => setEmail(ev.target.value)}
        />
      </FormField>
    </Dialog>
  );
}
