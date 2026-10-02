import {
  Button,
  Dialog,
  InlineAlert,
  Input,
  Select,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';

import {
  addTalentToSavedList,
  createTalentSavedList,
  listTalentSavedLists,
  type SavedListView,
  type SavedListVisibility,
} from '../saved-list-api';

// CRM-2 — bulk "Add to list" modal. Adds the selected Talent to an existing
// talent list or a newly-created one (name · purpose · Private/Tenant
// visibility, backend-enforced per CRM-1). Best-effort per-talent add with
// skip-existing tolerance; the richer multi-list / "View list" flow is CRM-3.

type Mode = 'pick' | 'create';

export function AddToListDialog({
  open,
  onClose,
  talentIds,
  onDone,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly talentIds: readonly string[];
  readonly onDone: (message: string) => void;
}) {
  const [lists, setLists] = useState<readonly SavedListView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [mode, setMode] = useState<Mode>('pick');
  const [listId, setListId] = useState('');
  const [newName, setNewName] = useState('');
  const [newPurpose, setNewPurpose] = useState('');
  const [newVisibility, setNewVisibility] = useState<SavedListVisibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(false);
    setError(null);
    setMode('pick');
    setListId('');
    setNewName('');
    setNewPurpose('');
    setNewVisibility('private');
    void listTalentSavedLists()
      .then((items) => {
        if (cancelled) return;
        setLists(items);
        // Default to the create flow when the tenant has no talent lists yet.
        setMode(items.length === 0 ? 'create' : 'pick');
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadErr(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const canSubmit = useMemo(() => {
    if (busy || talentIds.length === 0) return false;
    return mode === 'pick' ? listId !== '' : newName.trim() !== '';
  }, [busy, talentIds.length, mode, listId, newName]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      let targetId = listId;
      let targetName = lists.find((l) => l.id === listId)?.name ?? '';
      if (mode === 'create') {
        const created = await createTalentSavedList({
          name: newName.trim(),
          visibility: newVisibility,
          purpose: newPurpose,
        });
        targetId = created.id;
        targetName = created.name;
      }
      let added = 0;
      let skipped = 0;
      for (const id of talentIds) {
        try {
          await addTalentToSavedList(targetId, id);
          added += 1;
        } catch {
          // Already a member (or a per-row refusal) — skip, don't fail the batch.
          skipped += 1;
        }
      }
      const parts = [`Added ${added} to “${targetName}”`];
      if (skipped > 0) parts.push(`${skipped} already in the list`);
      onDone(`${parts.join(' · ')}.`);
      onClose();
    } catch {
      setError('Couldn’t add to the list. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to list"
      description={`Add ${talentIds.length} talent to a list.`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {mode === 'create' ? 'Create & add' : 'Add to list'}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="rc-empty">Loading lists…</p>
      ) : loadErr ? (
        <p className="rc-empty">Couldn’t load lists. Please try again.</p>
      ) : (
        <div className="rc-addlist">
          {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
          {lists.length > 0 ? (
            <div className="rc-addlist__modes" role="group" aria-label="Add to list mode">
              <Button
                unstyled
                type="button"
                className={mode === 'pick' ? 'on' : ''}
                aria-pressed={mode === 'pick'}
                onClick={() => setMode('pick')}
              >
                Existing list
              </Button>
              <Button
                unstyled
                type="button"
                className={mode === 'create' ? 'on' : ''}
                aria-pressed={mode === 'create'}
                onClick={() => setMode('create')}
              >
                New list
              </Button>
            </div>
          ) : null}

          {mode === 'pick' ? (
            <label className="rc-field">
              <span className="rc-field__lbl">List</span>
              <Select value={listId} onChange={(e) => setListId(e.target.value)}>
                <option value="">Choose a list…</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.visibility === 'tenant' ? ' (shared)' : ''}
                  </option>
                ))}
              </Select>
            </label>
          ) : (
            <>
              <label className="rc-field">
                <span className="rc-field__lbl">Name</span>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Senior React, West Coast"
                />
              </label>
              <label className="rc-field">
                <span className="rc-field__lbl">Purpose (optional)</span>
                <Input
                  value={newPurpose}
                  onChange={(e) => setNewPurpose(e.target.value)}
                  placeholder="What this list is for"
                />
              </label>
              <label className="rc-field">
                <span className="rc-field__lbl">Visibility</span>
                <Select
                  value={newVisibility}
                  onChange={(e) =>
                    setNewVisibility(e.target.value as SavedListVisibility)
                  }
                >
                  <option value="private">Private to me</option>
                  <option value="tenant">Shared with tenant</option>
                </Select>
              </label>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
