import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Dialog } from '@aramo/fe-foundation';
import { FOLDER_COPY, FOLDER_NAME_MAX, canCreateFolder, folderNameRefusal } from '@aramo/sign-client';

import { errorMessage } from './api';
import { foldersApi, foldersChanged, type SignFolder } from './folders-api';
import { createFolder, useFolders } from './folder-picker';
import { Btn, ErrorBox, Icon, LinkBtn, Loading, TextIn } from './ui';
import { useWorkspace } from './workspace';
import { EnvelopeList } from './pages/EnvelopeList';
import { InboxPage } from './pages/Inbox';

// SIGN-FREE-PARITY-1 S7 (FP-R8) — the signed-in user's own folders, for envelopes they sent
// and documents they received. The server decides everything (owner, name rule, cap); the
// name rule, cap and copy shown here are @aramo/sign-client folders.ts, the same as the app.
// An item is in at most one folder; deleting a folder never deletes an envelope.

/** Make, rename or delete a folder (shared by the folders page and one folder's page). */
function NameDialog({ open, title, initial, others, onClose, onSave }: { open: boolean; title: string; initial: string; others: string[]; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(initial);
    setError('');
  }, [open, initial]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const refusal = folderNameRefusal(name, others);
    if (refusal !== null) {
      setError(FOLDER_COPY[refusal]);
      return;
    }
    setBusy(true);
    try {
      await onSave(name);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={title}
      size="sm"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" disabled={busy} type="submit" form="folder-name-form" data-testid="folder-name-save">
            Save
          </Btn>
        </>
      }
    >
      <form id="folder-name-form" onSubmit={(e) => void save(e)}>
        <label className="sg-label" htmlFor="folder-name">
          Folder name
        </label>
        <TextIn id="folder-name" maxLength={FOLDER_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} data-testid="folder-name" />
        <p className="sg-help">Up to {FOLDER_NAME_MAX} characters.</p>
      </form>
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
    </Dialog>
  );
}

function DeleteFolderDialog({ folder, onClose, onDeleted }: { folder: SignFolder | null; onClose: () => void; onDeleted: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (folder === null) return;
    setBusy(true);
    setError('');
    try {
      await foldersApi.remove(folder.id);
      foldersChanged();
      onDeleted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={folder !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Delete this folder?"
      description={FOLDER_COPY.delete_note}
      size="sm"
      footer={
        <>
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant="danger" disabled={busy} onClick={() => void go()} data-testid="folder-delete-confirm">
            Delete folder
          </Btn>
        </>
      }
    >
      {folder !== null ? <strong>{folder.name}</strong> : null}
      {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
    </Dialog>
  );
}

/** /folders — the user's folders: make, rename, delete. */
export function FoldersPage() {
  const { base, toast } = useWorkspace();
  const { folders } = useFolders();
  // The sidebar's "New folder" opens the dialog straight away (?new=1).
  const [params, setParams] = useSearchParams();
  const [making, setMaking] = useState(params.get('new') === '1');
  const [renaming, setRenaming] = useState<SignFolder | null>(null);
  const [deleting, setDeleting] = useState<SignFolder | null>(null);
  const items = folders?.items ?? [];
  const names = (except?: string) => items.filter((f) => f.id !== except).map((f) => f.name);
  return (
    <div className="sg-page" data-testid="folders-page">
      <div className="sg-pagehead">
        <h1 className="sg-h1">Folders</h1>
        <div className="sg-pagehead__end">
          <Btn variant="primary" disabled={folders === null || !canCreateFolder(items.length)} onClick={() => setMaking(true)} data-testid="folder-new">
            <Icon name="plus" /> New folder
          </Btn>
        </div>
      </div>
      <p className="sg-muted" style={{ marginTop: 0 }}>
        Your own folders, for envelopes you send and documents you receive. Only you see them.
      </p>
      {folders === null ? <Loading /> : null}
      {folders !== null ? (
        <section className="sg-card">
          {items.length === 0 ? (
            <div className="sg-empty">
              <div className="sg-empty__t">No folders yet</div>
            </div>
          ) : (
            <table className="sg-table">
              <tbody>
                {items.map((f) => (
                  <tr key={f.id} data-testid={`folder-row-${f.id}`}>
                    <td>
                      <Link to={`${base}/folders/${f.id}`} style={{ color: 'var(--ink)', fontWeight: 600 }}>
                        {f.name}
                      </Link>
                    </td>
                    <td className="sg-muted">{f.sender_items + f.recipient_items} items</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <LinkBtn onClick={() => setRenaming(f)} data-testid={`folder-rename-${f.id}`}>
                        Rename
                      </LinkBtn>{' '}
                      <LinkBtn bad onClick={() => setDeleting(f)} aria-label={`Delete folder ${f.name}`} data-testid={`folder-delete-${f.id}`}>
                        <Icon name="trash" />
                      </LinkBtn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!canCreateFolder(items.length) && folders.limit > 0 ? <p className="sg-help" style={{ padding: '0 16px 12px' }}>{FOLDER_COPY.folder_limit_reached}</p> : null}
        </section>
      ) : null}
      <NameDialog
        open={making}
        title="New folder"
        initial=""
        others={names()}
        onClose={() => {
          setMaking(false);
          if (params.has('new')) setParams({}, { replace: true });
        }}
        onSave={async (name) => {
          await createFolder(name);
          toast('Folder made');
        }}
      />
      <NameDialog
        open={renaming !== null}
        title="Rename folder"
        initial={renaming?.name ?? ''}
        others={names(renaming?.id)}
        onClose={() => setRenaming(null)}
        onSave={async (name) => {
          if (renaming === null) return;
          await foldersApi.rename(renaming.id, name);
          foldersChanged();
          toast('Folder renamed');
        }}
      />
      <DeleteFolderDialog folder={deleting} onClose={() => setDeleting(null)} onDeleted={() => toast('Folder deleted')} />
    </div>
  );
}

/** /folders/:id — one folder: what the user sent and what they received, in one place. */
export function FolderPage() {
  const { id = '' } = useParams();
  const { base, toast } = useWorkspace();
  const navigate = useNavigate();
  const { folders } = useFolders();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState<SignFolder | null>(null);
  const folder = folders?.items.find((f) => f.id === id) ?? null;
  if (folders === null) return <Loading />;
  if (folder === null) {
    return (
      <div className="sg-page">
        <ErrorBox>{FOLDER_COPY.folder_not_found}</ErrorBox>
        <Link to={`${base}/folders`}>All folders</Link>
      </div>
    );
  }
  return (
    <div data-testid="folder-page">
      <EnvelopeList
        folder={folder.id}
        title={folder.name}
        headActions={
          <>
            <Btn onClick={() => setRenaming(true)} data-testid="folder-page-rename">
              Rename
            </Btn>
            <Btn variant="ghost" onClick={() => setDeleting(folder)} data-testid="folder-page-delete">
              Delete folder
            </Btn>
          </>
        }
      />
      <InboxPage embedded folder={folder.id} />
      <NameDialog
        open={renaming}
        title="Rename folder"
        initial={folder.name}
        others={folders.items.filter((f) => f.id !== folder.id).map((f) => f.name)}
        onClose={() => setRenaming(false)}
        onSave={async (name) => {
          await foldersApi.rename(folder.id, name);
          foldersChanged();
          toast('Folder renamed');
        }}
      />
      <DeleteFolderDialog
        folder={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          toast('Folder deleted');
          navigate(`${base}/folders`);
        }}
      />
    </div>
  );
}
