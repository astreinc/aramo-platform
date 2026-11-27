import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Dialog } from '@aramo/fe-foundation';
import { FOLDER_COPY, FOLDER_NAME_MAX, canCreateFolder, folderNameRefusal } from '@aramo/sign-client';

import { errorMessage } from './api';
import { foldersApi, foldersChanged, onFoldersChanged, type SignFolder, type SignFolderList } from './folders-api';
import { Btn, ErrorBox, Icon, Loading, TextIn } from './ui';

// SIGN-FREE-PARITY-1 S7 (FP-R8) — the folder list hook and "Move to folder", used by the
// sidebar, the envelope list and detail, and the inbox. The name rule, cap and copy are
// @aramo/sign-client folders.ts (the same as the app); the server decides.

/** The user's folders (null while loading); reloads whenever any screen changes them. */
export function useFolders(): { folders: SignFolderList | null; reload: () => void } {
  const [folders, setFolders] = useState<SignFolderList | null>(null);
  const reload = useCallback(() => {
    foldersApi.list().then(setFolders, () => setFolders({ items: [], limit: 0, name_max: FOLDER_NAME_MAX, can_create: false }));
  }, []);
  useEffect(() => {
    reload();
    return onFoldersChanged(reload);
  }, [reload]);
  return { folders, reload };
}

/** Make a folder; returns it, or throws the server's refusal. */
export async function createFolder(name: string): Promise<SignFolder> {
  const f = await foldersApi.create(name);
  foldersChanged();
  return f;
}

export type FolderTarget = { kind: 'sender'; id: string; subject: string; folder_id: string | null } | { kind: 'inbox'; id: string; subject: string; folder_id: string | null };

/**
 * "Move to folder" — pick one of the user's folders (or make one), or take the item out of
 * its folder. `onDone` runs after a change so the caller can reload its list.
 */
export function MoveToFolderDialog(props: { target: FolderTarget | null; onClose: () => void; onDone: () => void; toast: (m: string) => void }) {
  // The folder list is read only while the dialog is open.
  return props.target === null ? null : <MoveToFolder {...props} target={props.target} />;
}

function MoveToFolder({ target, onClose, onDone, toast }: { target: FolderTarget; onClose: () => void; onDone: () => void; toast: (m: string) => void }) {
  const { folders } = useFolders();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName('');
    setError('');
  }, [target]);

  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      foldersChanged();
      toast(message);
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const move = (f: SignFolder) => {
    void run(() => (target.kind === 'sender' ? foldersApi.moveEnvelope(target.id, f.id) : foldersApi.moveInboxItem(target.id, f.id)), `Moved to ${f.name}`);
  };
  const takeOut = () => {
    void run(() => (target.kind === 'sender' ? foldersApi.removeEnvelope(target.id) : foldersApi.removeInboxItem(target.id)), 'Removed from the folder');
  };
  const makeAndMove = async (e: FormEvent) => {
    e.preventDefault();
    const refusal = folderNameRefusal(name, (folders?.items ?? []).map((f) => f.name));
    if (refusal !== null) {
      setError(FOLDER_COPY[refusal]);
      return;
    }
    setBusy(true);
    try {
      const f = await createFolder(name);
      setBusy(false);
      move(f);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const items = folders?.items ?? [];
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Move to folder"
      description={target.subject}
      size="sm"
      footer={
        <>
          {target.folder_id != null ? (
            <Btn disabled={busy} onClick={takeOut} data-testid="folder-take-out">
              Remove from folder
            </Btn>
          ) : null}
          <Btn onClick={onClose}>Cancel</Btn>
        </>
      }
    >
      {folders === null ? <Loading /> : null}
      {folders !== null && items.length === 0 ? <p className="sg-muted">You have no folders yet. Make one below.</p> : null}
      <div style={{ display: 'grid', gap: 6, marginBottom: 12 }} data-testid="folder-choices">
        {items.map((f) => (
          <Btn key={f.id} block disabled={busy || f.id === target.folder_id} onClick={() => move(f)} data-testid={`folder-choice-${f.id}`} style={{ justifyContent: 'flex-start' }}>
            <Icon name="folder" /> {f.name}
            {f.id === target.folder_id ? <span className="sg-muted"> · here now</span> : null}
          </Btn>
        ))}
      </div>
      {folders !== null && canCreateFolder(items.length) ? (
        <form onSubmit={(e) => void makeAndMove(e)} style={{ display: 'flex', gap: 8 }}>
          <TextIn aria-label="New folder name" placeholder="New folder" maxLength={FOLDER_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} data-testid="folder-new-name" />
          <Btn type="submit" variant="primary" disabled={busy || name.trim() === ''} data-testid="folder-new-move">
            Make and move
          </Btn>
        </form>
      ) : folders !== null ? (
        <p className="sg-help">{FOLDER_COPY.folder_limit_reached}</p>
      ) : null}
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
    </Dialog>
  );
}

