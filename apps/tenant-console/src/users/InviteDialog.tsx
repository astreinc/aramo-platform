import { useState } from 'react';

import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { FormField } from '../components/FormField';
import { InlineAlert } from '../components/InlineAlert';
import { useToast } from '../components/Toast';

import { RolePicker } from './RolePicker';
import { messageForInviteError, type ErrorMessage } from './error-messages';
import type { InviteResponse } from './types';
import {
  inviteTenantUser,
  type FinancialsToggleState,
} from './users-api';

// Settings S5b — invite Dialog.
//
// Wires POST /v1/tenant/users/invitations. The role-picker is shared
// with the role-assign editor (RolePicker). On success the toast fires
// and the caller's refresh callback runs (list refreshes). On rejection
// the per-reason mapper produces an operator message:
//   - D5 invertible_role_union → the bundle-naming template (ruling 3)
//   - S4 financials_audit_not_enabled → points the admin at Settings
//   - invalid_email / empty_role_keys / cognito_provision_failed → mapped
//
// The picker reads the financials toggle state (the courtesy probe);
// auditor_with_financials is proactively disabled when known-off, and
// stays enabled on a 403 (the BE rejection is the floor — ruling 4).

interface InviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: (result: InviteResponse) => void;
  financialsToggle: FinancialsToggleState;
  // Test seam.
  inviteFn?: typeof inviteTenantUser;
}

export function InviteDialog({
  open,
  onOpenChange,
  onInvited,
  financialsToggle,
  inviteFn,
}: InviteDialogProps) {
  const invite = inviteFn ?? inviteTenantUser;
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const onToggleRole = (key: string, nextSelected: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (nextSelected) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const reset = () => {
    setEmail('');
    setDisplayName('');
    setSelectedKeys(new Set());
    setError(null);
    setSaving(false);
  };

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const result = await invite({
        email: email.trim(),
        display_name: displayName.trim() === '' ? null : displayName.trim(),
        role_keys: [...selectedKeys].sort(),
      });
      toast.show(`Invitation sent to ${email.trim()}.`);
      onInvited(result);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForInviteError(err));
    } finally {
      setSaving(false);
    }
  };

  const submittable =
    !saving && email.trim().length > 0 && selectedKeys.size > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Invite a user"
      description="They’ll receive an email to set their password and finish signup."
      size="lg"
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
            data-testid="invite-submit"
          >
            {saving ? 'Sending…' : 'Send invite'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={onSubmit}
        aria-label="Invite user form"
        data-testid="invite-form"
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
        <FormField
          label={<label htmlFor="invite-email">Email</label>}
        >
          <input
            id="invite-email"
            type="email"
            className="tc-input"
            autoComplete="off"
            required
            value={email}
            disabled={saving}
            onChange={(ev) => setEmail(ev.target.value)}
          />
        </FormField>
        <FormField
          label={<label htmlFor="invite-display-name">Display name</label>}
          helper="Optional — falls back to the email if blank."
        >
          <input
            id="invite-display-name"
            type="text"
            className="tc-input"
            autoComplete="off"
            value={displayName}
            disabled={saving}
            onChange={(ev) => setDisplayName(ev.target.value)}
          />
        </FormField>
        <FormField
          label={<div className="tc-label">Roles</div>}
          helper="Select one or more roles to grant on invite."
        >
          <RolePicker
            selectedKeys={selectedKeys}
            onToggle={onToggleRole}
            disabled={saving}
            financialsToggle={financialsToggle}
          />
        </FormField>
      </form>
    </Dialog>
  );
}
