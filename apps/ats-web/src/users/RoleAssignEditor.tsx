import { useEffect, useMemo, useState } from 'react';
import { Button } from '@aramo/fe-foundation';
import { Dialog } from '@aramo/fe-foundation';
import { FormField } from '@aramo/fe-foundation';
import { InlineAlert } from '@aramo/fe-foundation';
import { useToast } from '@aramo/fe-foundation';

import { RolePicker } from './RolePicker';
import {
  messageForRoleAssignError,
  type ErrorMessage,
} from './error-messages';
import type {
  AssignRolesResponse,
  TenantRoleCatalogEntry,
  TenantUserView,
} from './types';
import {
  assignTenantUserRoles,
  type FinancialsToggleState,
} from './users-api';

// Settings S5b — THE ROLE-ASSIGN EDITOR (the real design surface).
//
// Wires PATCH /v1/tenant/users/:user_id/roles. The picker is shared
// with InviteDialog. Edits are batched + applied with an EXPLICIT save
// (not save-on-each-toggle — a role-set is a deliberate edit).
//
// THE FOUR CHARTER FEATURES:
//
//   1. Explicit save with before/after.
//      The picker reflects the desired state; the diff block shows the
//      before-set + the next-set (additions in +, removals in -). Save
//      computes the delta server-side (the BE returns added/removed).
//
//   2. The S4 gate reflected (ruling 4).
//      auditor_with_financials is proactively disabled when the
//      financials toggle is known-off. On a 403 (the courtesy probe
//      could not read settings), the option stays enabled — the BE
//      rejection is the floor.
//
//   3. THE D5 REJECTION UX (ruling 3 — the load-bearing payoff).
//      An invertible role-union surfaces the BUNDLE-NAMING template
//      ("Roles Recruiter + Finance form a combination that would
//      expose pay rates."). The `cause` string is NEVER rendered.
//
//   4. Idempotency surfaced as no-op.
//      A save with no delta is suppressed at the FE (the Save button
//      stays disabled until the picker diverges from the loaded set).
//      The BE also suppresses audit when both delta lists are empty.

interface RoleAssignEditorProps {
  user: TenantUserView | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (result: AssignRolesResponse) => void;
  financialsToggle: FinancialsToggleState;
  // Settings Rebuild D5 — the assignable roles (from the roles-catalog GET).
  roles: readonly TenantRoleCatalogEntry[];
  // Test seam.
  assignFn?: typeof assignTenantUserRoles;
}

function setEquals(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

export function RoleAssignEditor({
  user,
  onOpenChange,
  onSaved,
  financialsToggle,
  roles,
  assignFn,
}: RoleAssignEditorProps) {
  const assign = assignFn ?? assignTenantUserRoles;
  const toast = useToast();
  const labelFor = (key: string): string =>
    roles.find((r) => r.key === key)?.label ?? key;

  const initial = useMemo<ReadonlySet<string>>(
    () => new Set(user?.role_keys ?? []),
    [user],
  );

  const [selectedKeys, setSelectedKeys] =
    useState<ReadonlySet<string>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  // Re-seed the selection whenever the editor opens on a new user (or
  // the same user with a refreshed role-set). The dep is `user` itself
  // so a closed/reopened editor resets cleanly.
  useEffect(() => {
    setSelectedKeys(initial);
    setError(null);
    setSaving(false);
  }, [initial]);

  const onToggleRole = (key: string, nextSelected: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (nextSelected) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const dirty = !setEquals(initial, selectedKeys);
  const adds = useMemo(
    () => [...selectedKeys].filter((k) => !initial.has(k)).sort(),
    [initial, selectedKeys],
  );
  const removes = useMemo(
    () => [...initial].filter((k) => !selectedKeys.has(k)).sort(),
    [initial, selectedKeys],
  );

  const onSave = async () => {
    if (user === null) return;
    if (selectedKeys.size === 0) {
      setError({ title: 'Select at least one role.' });
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const result = await assign({
        userId: user.user_id,
        body: { role_keys: [...selectedKeys].sort() },
      });
      toast.show(`Updated roles for ${user.email}.`);
      onSaved(result);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForRoleAssignError(err, labelFor));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={user !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          setSaving(false);
        }
        onOpenChange(next);
      }}
      title="Edit roles"
      description={
        user !== null
          ? `Adjust the role-set for ${user.display_name ?? user.email}.`
          : undefined
      }
      size="lg"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={!dirty || saving || user === null}
            data-testid="role-assign-save"
          >
            {saving ? 'Saving…' : 'Save changes'}
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
      <FormField
        label="Roles"
        helper="Select all roles this user should hold."
      >
        <RolePicker
          roles={roles}
          selectedKeys={selectedKeys}
          onToggle={onToggleRole}
          disabled={saving}
          financialsToggle={financialsToggle}
        />
      </FormField>
      {dirty && (
        <div
          className="rc-diff"
          role="status"
          aria-label="Pending changes"
          data-testid="role-assign-diff"
        >
          <span className="rc-diff__label">Adding</span>
          <span className="rc-diff__value">
            {adds.length === 0 ? '—' : adds.map(labelFor).join(', ')}
          </span>
          <span className="rc-diff__label">Removing</span>
          <span className="rc-diff__value">
            {removes.length === 0 ? '—' : removes.map(labelFor).join(', ')}
          </span>
        </div>
      )}
    </Dialog>
  );
}
