import {
  Button,
  Checkbox,
  Dialog,
  InlineAlert,
  Input,
  Select,
} from '@aramo/fe-foundation';
import { useEffect, useMemo, useState } from 'react';

import {
  addTalentToSavedList,
  createTalentSavedList,
  listTalentMemberships,
  listTalentSavedLists,
  type SavedListRowView,
  type SavedListVisibility,
} from '../saved-list-api';

// CRM-3 — bulk "Add to list" modal (prototype §7.2): multi-list selection with
// per-list already-in counts, silent skip of duplicates (the backend add is
// idempotent), inline create (name · purpose · Private/Tenant), and a "View
// list" affordance on success. Authority stays server-side (visibility +
// idempotent add); the modal never fabricates membership.

export function AddToListDialog({
  open,
  onClose,
  talentIds,
  onDone,
  onViewList,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly talentIds: readonly string[];
  readonly onDone: (message: string) => void;
  readonly onViewList?: () => void;
}) {
  const [lists, setLists] = useState<readonly SavedListRowView[]>([]);
  const [alreadyInByList, setAlreadyInByList] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPurpose, setNewPurpose] = useState('');
  const [newVisibility, setNewVisibility] = useState<SavedListVisibility>('private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr(false);
    setError(null);
    setDone(false);
    setSelected(new Set());
    setCreating(false);
    setNewName('');
    setNewPurpose('');
    setNewVisibility('private');
    Promise.all([listTalentSavedLists(), listTalentMemberships(talentIds)])
      .then(([items, memberships]) => {
        if (cancelled) return;
        setLists(items);
        // already-in per list = # of the selected talent already a member.
        const counts: Record<string, number> = {};
        for (const m of memberships) {
          for (const l of m.lists) counts[l.id] = (counts[l.id] ?? 0) + 1;
        }
        setAlreadyInByList(counts);
        setCreating(items.length === 0);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadErr(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, talentIds]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canSubmit = useMemo(() => {
    if (busy || talentIds.length === 0) return false;
    return creating ? newName.trim() !== '' : selected.size > 0;
  }, [busy, talentIds.length, creating, newName, selected]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const targets: Array<{ id: string; name: string }> = [];
      if (creating) {
        const created = await createTalentSavedList({
          name: newName.trim(),
          visibility: newVisibility,
          purpose: newPurpose,
        });
        targets.push({ id: created.id, name: created.name });
      }
      for (const l of lists) if (selected.has(l.id)) targets.push({ id: l.id, name: l.name });

      let added = 0;
      let skipped = 0;
      for (const target of targets) {
        const alreadyIn = alreadyInByList[target.id] ?? 0;
        for (const talentId of talentIds) {
          // The backend add is idempotent — a duplicate is a benign no-op.
          await addTalentToSavedList(target.id, talentId);
        }
        added += talentIds.length - alreadyIn;
        skipped += alreadyIn;
      }
      const listWord = targets.length === 1 ? 'list' : `${targets.length} lists`;
      const parts = [`Added ${Math.max(0, added)} to ${listWord}`];
      if (skipped > 0) parts.push(`${skipped} already in`);
      onDone(`${parts.join(' · ')}.`);
      setDone(true);
    } catch {
      setError('Couldn’t add to the list. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const footer = done ? (
    <>
      {onViewList !== undefined ? (
        <Button
          variant="ghost"
          onClick={() => {
            onViewList();
            onClose();
          }}
        >
          View list
        </Button>
      ) : null}
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
        {creating
          ? 'Create & add'
          : `Add to ${selected.size || ''} ${selected.size === 1 ? 'list' : 'lists'}`.trim()}
      </Button>
    </>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Add to list"
      description={`Add ${talentIds.length} talent to one or more lists.`}
      size="sm"
      footer={footer}
    >
      {loading ? (
        <p className="rc-empty">Loading lists…</p>
      ) : loadErr ? (
        <p className="rc-empty">Couldn’t load lists. Please try again.</p>
      ) : done ? (
        <p className="rc-addlist__donemsg">Done — talent added to the selected list(s).</p>
      ) : (
        <div className="rc-addlist">
          {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}

          {!creating ? (
            <div className="rc-addlist__pick" role="group" aria-label="Choose lists">
              {lists.length === 0 ? (
                <p className="rc-empty">No lists yet — create one below.</p>
              ) : (
                lists.map((l) => {
                  const alreadyIn = alreadyInByList[l.id] ?? 0;
                  return (
                    <label key={l.id} className="rc-addlist__opt">
                      <Checkbox checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                      <span className="rc-addlist__optnm">
                        {l.name}
                        {l.visibility === 'tenant' ? <small> · shared</small> : null}
                      </span>
                      {alreadyIn > 0 ? (
                        <span className="rc-addlist__already">
                          {alreadyIn === talentIds.length
                            ? 'all already in'
                            : `${alreadyIn} of ${talentIds.length} already in`}
                        </span>
                      ) : null}
                    </label>
                  );
                })
              )}
            </div>
          ) : null}

          <Button
            unstyled
            type="button"
            className="rc-addlist__createtoggle"
            aria-pressed={creating}
            onClick={() => setCreating((c) => !c)}
          >
            {creating ? '← Choose an existing list' : '+ Create new list'}
          </Button>

          {creating ? (
            <div className="rc-addlist__new">
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
                  onChange={(e) => setNewVisibility(e.target.value as SavedListVisibility)}
                >
                  <option value="private">Private to me</option>
                  <option value="tenant">Shared with tenant</option>
                </Select>
              </label>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
