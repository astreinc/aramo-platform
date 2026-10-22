import { useEffect, useState } from 'react';
import { useToast } from '@aramo/fe-foundation';

import { OrgModal } from '../ui/OrgPage';

import { personName } from './directory';
import { KEEP_ONE_ROLE_HINT, roleWriteErrorMessage, type RoleGroup } from './role-groups';
import { RoleGroupsPicker } from './RoleGroupsPicker';
import type { TenantUserView } from './types';
import { assignTenantUserRoles } from './users-api';

// ORG-UX-1 (handoff §6.4 "Edit access"; Directive v1.0 LOCKED §4.4) — the ONLY per-person
// role editor (opened from Users & invitations). Whole-set replace through the existing
// PATCH /v1/tenant/users/:id/roles; the server writes the audit and enforces every rule
// (owner authority, last owner, ≥1 role). Roles the modal does not show (an app the tenant
// no longer subscribes to) are kept in the set untouched.
export function EditAccessModal({
  user,
  groups,
  callerIsOwner,
  onOpenChange,
  onSaved,
}: {
  /** The person being edited; null = closed. */
  readonly user: TenantUserView | null;
  readonly groups: readonly RoleGroup[];
  readonly callerIsOwner: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(user?.role_keys ?? []);
    setError(null);
    setSaving(false);
  }, [user]);

  if (user === null) return null;
  const name = personName(user);
  const none = draft.length === 0;

  const save = async () => {
    if (none || saving) return;
    setSaving(true);
    setError(null);
    try {
      await assignTenantUserRoles({ userId: user.user_id, body: { role_keys: draft } });
      toast.show('Access updated. Each app shows the new roles read-only.');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(roleWriteErrorMessage(err));
      setSaving(false);
    }
  };

  return (
    <OrgModal
      open
      onOpenChange={onOpenChange}
      testId="edit-access-modal"
      title={`Edit access · ${name}`}
      subtitle={`${user.email} · roles are assigned here; each app shows them read-only.`}
      footer={
        <>
          <button type="button" className="ox-btn ox-btn--secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="button" className="ox-btn ox-btn--primary" disabled={none || saving} onClick={() => void save()} data-testid="save-access">
            Save access
          </button>
        </>
      }
    >
      <RoleGroupsPicker groups={groups} selected={draft} onChange={setDraft} callerIsOwner={callerIsOwner} />
      <p className="oxp-footnote" style={{ margin: 0 }}>
        Changes apply the next time they open each app. {KEEP_ONE_ROLE_HINT}
      </p>
      {error !== null ? (
        <div className="ox-alert ox-alert--error" role="alert">
          {error}
        </div>
      ) : null}
    </OrgModal>
  );
}
