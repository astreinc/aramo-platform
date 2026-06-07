import { useMemo, useState } from 'react';
import { Button } from '@aramo/fe-foundation';
import { Combobox, type ComboboxItem } from '@aramo/fe-foundation';
import { Dialog } from '@aramo/fe-foundation';
import { FormField } from '@aramo/fe-foundation';
import { InlineAlert } from '@aramo/fe-foundation';
import { useToast } from '@aramo/fe-foundation';

import type { UserRosterState } from '../users/users-api';

import {
  messageForCreateTeamError,
  type ErrorMessage,
} from './error-messages';
import { createTeam } from './teams-api';
import type { CreateTeamResponse } from './types';

// Settings S5c-2 — CreateTeamDialog.
//
// PL-94 §2 ruling 5 — the create flow uses the SHARED Combobox for the
// owner picker (a team has one owner; the picker selects from the
// roster).
//
// PL-94 §2 ruling 7 — picker-source 403 fallback. When the roster
// probe returned `forbidden`, the owner picker degrades to a raw-UUID
// input (the S5c-1 AddEdgeDialog precedent — mirrored here).
//
// PL-94 §2 ruling 6 — DUPLICATE-NAME on create is REJECTED (not
// idempotent). The error mapper renders the offending name from
// `details.name`.

interface CreateTeamDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roster: UserRosterState;
  onCreated: (result: CreateTeamResponse) => void;
  // Test seam.
  createFn?: typeof createTeam;
}

function rosterToItems(
  roster: UserRosterState,
): ReadonlyArray<ComboboxItem> {
  if (roster.state !== 'ready') return [];
  return [...roster.users]
    .sort((a, b) => {
      const an = a.display_name ?? a.email;
      const bn = b.display_name ?? b.email;
      return an.localeCompare(bn);
    })
    .map((u) => ({
      value: u.user_id,
      label: u.display_name ?? u.email,
      description: u.display_name !== null ? u.email : undefined,
    }));
}

export function CreateTeamDialog({
  open,
  onOpenChange,
  roster,
  onCreated,
  createFn,
}: CreateTeamDialogProps) {
  const create = createFn ?? createTeam;
  const toast = useToast();

  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);

  const items = useMemo(() => rosterToItems(roster), [roster]);

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
        {roster.state === 'forbidden' && (
          <InlineAlert variant="error">
            User roster isn’t available to your role. Paste the owner’s
            user ID instead — the server validates it on save.
          </InlineAlert>
        )}
        <FormField label={<label htmlFor="create-team-name">Name</label>}>
          <input
            id="create-team-name"
            type="text"
            className="tc-input"
            value={name}
            disabled={saving}
            onChange={(ev) => setName(ev.target.value)}
            data-testid="create-team-name-input"
          />
        </FormField>
        {roster.state === 'ready' ? (
          <FormField
            label={<div className="tc-label">Owner</div>}
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
        ) : (
          <FormField
            label={<label htmlFor="create-team-owner-uuid">Owner user ID</label>}
            helper="UUID from your records."
          >
            <input
              id="create-team-owner-uuid"
              type="text"
              className="tc-input"
              value={owner}
              disabled={saving}
              onChange={(ev) => setOwner(ev.target.value)}
              data-testid="create-team-owner-input"
            />
          </FormField>
        )}
      </form>
    </Dialog>
  );
}
