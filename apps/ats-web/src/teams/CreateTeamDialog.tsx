import {
  Button,
  Combobox,
  type ComboboxItem,
  Dialog,
  FormField,
  InlineAlert,
  useToast,
} from '@aramo/fe-foundation';
import { useMemo, useState } from 'react';

import type { AssignableUser } from '../users/users-api';

import { messageForCreateTeamError, type ErrorMessage } from './error-messages';
import { createTeam } from './teams-api';
import type { CreateTeamResponse } from './types';

// CreateTeamDialog (ported to ats-web, FE Consolidation Directive 5).
// §5 D4c — the owner PICKER sources the assignable endpoint (active roster);
// the Combobox always renders (no 403→raw-UUID fallback). Duplicate-NAME on
// create is REJECTED (not idempotent).

interface CreateTeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: readonly AssignableUser[];
  onCreated: (result: CreateTeamResponse) => void;
  // Test seam.
  createFn?: typeof createTeam;
}

function rosterToItems(
  users: readonly AssignableUser[],
): ReadonlyArray<ComboboxItem> {
  return [...users]
    .sort((a, b) =>
      (a.display_name ?? a.user_id).localeCompare(b.display_name ?? b.user_id),
    )
    .map((u) => ({ value: u.user_id, label: u.display_name ?? u.user_id }));
}

export function CreateTeamDialog({
  open,
  onOpenChange,
  users,
  onCreated,
  createFn,
}: CreateTeamDialogProps) {
  const create = createFn ?? createTeam;
  const toast = useToast();

  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const items = useMemo(() => rosterToItems(users), [users]);

  const reset = () => {
    setName('');
    setOwner('');
    setError(null);
    setSaving(false);
  };

  const onSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const result = await create({
        name: name.trim(),
        owner_user_id: owner.trim(),
      });
      toast.show(`Team "${result.name}" created.`);
      onCreated(result);
      reset();
      onOpenChange(false);
    } catch (err: unknown) {
      setError(messageForCreateTeamError(err));
    } finally {
      setSaving(false);
    }
  };

  const submittable =
    !saving && name.trim().length > 0 && owner.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title="Create team"
      description="Teams group users into pods with a single owner (the AM)."
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
            data-testid="create-team-submit"
          >
            {saving ? 'Creating…' : 'Create team'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={onSubmit}
        aria-label="Create team form"
        data-testid="create-team-form"
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
        <FormField label={<label htmlFor="create-team-name">Name</label>}>
          <input
            id="create-team-name"
            type="text"
            className="rc-input"
            value={name}
            disabled={saving}
            onChange={(ev) => setName(ev.target.value)}
            data-testid="create-team-name-input"
          />
        </FormField>
        <FormField
          label="Owner"
          helper="The team’s AM-anchor (one owner per pod)."
        >
          <Combobox
            items={items}
            value={owner.length > 0 ? owner : null}
            onSelect={(item) => setOwner(item.value)}
            placeholder="Select an owner…"
            emptyMessage="No matching users."
            ariaLabel="Team owner"
            disabled={saving}
            testId="create-team-owner-combobox"
          />
        </FormField>
      </form>
    </Dialog>
  );
}
