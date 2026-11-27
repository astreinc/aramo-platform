// SIGN-FREE-PARITY-1 S7 (FP-R8) — "Move to folder" and "Folders" (make, rename, delete), the
// app's side of the web's folder dialogs. The name rule, cap and copy are @aramo/sign-client
// folders.ts (the web shows the same words); the server decides. An item is in at most one
// folder; deleting a folder never deletes an envelope.
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { FOLDER_COPY, FOLDER_NAME_MAX, canCreateFolder, folderNameRefusal } from '@aramo/sign-client';

import { Button } from '../../components/Button';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useServices } from '../../app/ServicesContext';
import { useTheme } from '../../theme';
import { OFFLINE_ACTION_REASON, signKeys, useFolders, useOnline } from '../inbox/queries';
import { createFolder, deleteFolder, moveToFolder, removeFromFolder, renameFolder, type FolderTarget, type SignFolder } from './foldersApi';

function useRefreshAfterChange(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: signKeys.folders });
    void qc.invalidateQueries({ queryKey: signKeys.senderList });
    void qc.invalidateQueries({ queryKey: signKeys.inbox });
    void qc.invalidateQueries({ queryKey: ['sign', 'sender', 'envelope'] });
  };
}

function NameInput({ value, onChange, testID, label }: { readonly value: string; readonly onChange: (v: string) => void; readonly testID: string; readonly label: string }) {
  const t = useTheme();
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChange}
      placeholder="Folder name"
      accessibilityLabel={label}
      maxLength={FOLDER_NAME_MAX}
      style={{
        minHeight: t.size.minTouch,
        borderWidth: 1,
        borderColor: t.color.separator,
        borderRadius: 10,
        paddingHorizontal: 12,
        fontSize: 16,
        color: t.color.text,
        backgroundColor: t.color.surface,
      }}
    />
  );
}

function ErrorText({ message }: { readonly message: string | null }) {
  const t = useTheme();
  return message ? (
    <Text accessibilityRole="alert" style={{ color: t.color.destructive, fontFamily: t.font.family }}>
      {message}
    </Text>
  ) : null;
}

function FolderRow({ folder, here, disabled, onPress }: { readonly folder: SignFolder; readonly here: boolean; readonly disabled: boolean; readonly onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      testID={`folder-choice-${folder.id}`}
      onPress={onPress}
      disabled={disabled || here}
      accessibilityRole="button"
      accessibilityLabel={here ? `${folder.name}, here now` : `Move to ${folder.name}`}
      accessibilityState={{ disabled: disabled || here }}
      style={{ minHeight: t.size.minTouch, justifyContent: 'center', borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator }}
    >
      <Text style={{ color: here ? t.color.textSecondary : t.color.text, fontSize: 16, fontFamily: t.font.family }}>
        {here ? `${folder.name} · here now` : folder.name}
      </Text>
    </Pressable>
  );
}

/** "Move to folder" for one envelope or received document; null target = closed. */
export function MoveToFolderSheet({ target, onClose }: { readonly target: FolderTarget | null; readonly onClose: () => void }) {
  const t = useTheme();
  const { workspace } = useServices();
  const toast = useToast();
  const online = useOnline();
  const folders = useFolders();
  const refresh = useRefreshAfterChange();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = folders.data?.items ?? [];

  const close = () => {
    setName('');
    setError(null);
    onClose();
  };
  async function move(folder: SignFolder): Promise<void> {
    if (target === null) return;
    setBusy(true);
    setError(null);
    const r = await moveToFolder(workspace, target, folder.id);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    refresh();
    toast.show(`Moved to ${folder.name}`);
    close();
  }
  async function takeOut(): Promise<void> {
    if (target === null) return;
    setBusy(true);
    setError(null);
    const r = await removeFromFolder(workspace, target);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    refresh();
    toast.show('Removed from the folder');
    close();
  }
  async function makeAndMove(): Promise<void> {
    const refusal = folderNameRefusal(name, items.map((f) => f.name));
    if (refusal !== null) return setError(FOLDER_COPY[refusal]);
    setBusy(true);
    setError(null);
    const made = await createFolder(workspace, name);
    setBusy(false);
    if (!made.ok) return setError(made.message);
    await move(made.folder);
  }

  return (
    <Sheet visible={target !== null} onClose={close} title="Move to folder">
      {target ? (
        <Text numberOfLines={2} style={{ color: t.color.textSecondary, fontSize: 15, fontFamily: t.font.family }}>
          {target.subject}
        </Text>
      ) : null}
      {!online ? <Text style={{ color: t.color.textSecondary }}>{OFFLINE_ACTION_REASON}</Text> : null}
      {folders.data && items.length === 0 ? (
        <Text style={{ color: t.color.textSecondary, fontFamily: t.font.family }}>You have no folders yet. Make one below.</Text>
      ) : null}
      <View testID="folder-choices">
        {items.map((f) => (
          <FolderRow key={f.id} folder={f} here={f.id === target?.folderId} disabled={busy || !online} onPress={() => void move(f)} />
        ))}
      </View>
      {folders.data && canCreateFolder(items.length) ? (
        <>
          <NameInput testID="folder-new-name" label="New folder name" value={name} onChange={setName} />
          <Button testID="folder-new-move" title="Make and move" disabled={!online || name.trim() === ''} busy={busy} onPress={() => void makeAndMove()} />
        </>
      ) : folders.data ? (
        <Text style={{ color: t.color.textSecondary }}>{FOLDER_COPY.folder_limit_reached}</Text>
      ) : null}
      <ErrorText message={error} />
      {target?.folderId ? <Button testID="folder-take-out" title="Remove from folder" variant="secondary" disabled={!online || busy} onPress={() => void takeOut()} /> : null}
      <Button title="Cancel" variant="text" onPress={close} />
    </Sheet>
  );
}

/** "Folders" — make, rename and delete the user's folders. */
export function ManageFoldersSheet({ visible, onClose }: { readonly visible: boolean; readonly onClose: () => void }) {
  const t = useTheme();
  const { workspace } = useServices();
  const toast = useToast();
  const online = useOnline();
  const folders = useFolders();
  const refresh = useRefreshAfterChange();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = folders.data?.items ?? [];

  const close = () => {
    setName('');
    setEditing(null);
    setError(null);
    onClose();
  };
  async function make(): Promise<void> {
    const refusal = folderNameRefusal(name, items.map((f) => f.name));
    if (refusal !== null) return setError(FOLDER_COPY[refusal]);
    setBusy(true);
    setError(null);
    const r = await createFolder(workspace, name);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setName('');
    refresh();
    toast.show('Folder made');
  }
  async function saveRename(): Promise<void> {
    if (editing === null) return;
    const refusal = folderNameRefusal(editing.name, items.filter((f) => f.id !== editing.id).map((f) => f.name));
    if (refusal !== null) return setError(FOLDER_COPY[refusal]);
    setBusy(true);
    setError(null);
    const r = await renameFolder(workspace, editing.id, editing.name);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setEditing(null);
    refresh();
    toast.show('Folder renamed');
  }
  function confirmDelete(folder: SignFolder): void {
    Alert.alert('Delete this folder?', FOLDER_COPY.delete_note, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete folder',
        style: 'destructive',
        onPress: () =>
          void (async () => {
            const r = await deleteFolder(workspace, folder.id);
            if (!r.ok) return setError(r.message);
            refresh();
            toast.show('Folder deleted');
          })(),
      },
    ]);
  }

  return (
    <Sheet visible={visible} onClose={close} title="Folders">
      <Text style={{ color: t.color.textSecondary, fontSize: 15, fontFamily: t.font.family }}>
        Your own folders, for envelopes you send and documents you receive. Only you see them.
      </Text>
      {!online ? <Text style={{ color: t.color.textSecondary }}>{OFFLINE_ACTION_REASON}</Text> : null}
      <View testID="manage-folders">
        {items.map((f) =>
          editing?.id === f.id ? (
            <View key={f.id} style={{ gap: 8, paddingVertical: 8 }}>
              <NameInput testID="folder-rename-input" label={`Rename ${f.name}`} value={editing.name} onChange={(v) => setEditing({ id: f.id, name: v })} />
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button testID="folder-rename-save" title="Save" disabled={!online} busy={busy} onPress={() => void saveRename()} />
                <Button title="Cancel" variant="text" onPress={() => setEditing(null)} />
              </View>
            </View>
          ) : (
            <View key={f.id} testID={`folder-row-${f.id}`} style={{ flexDirection: 'row', alignItems: 'center', minHeight: t.size.minTouch, borderBottomWidth: t.size.separatorWidth, borderBottomColor: t.color.separator }}>
              <Text numberOfLines={1} style={{ flex: 1, color: t.color.text, fontSize: 16, fontFamily: t.font.family }}>
                {f.name}
              </Text>
              <Button testID={`folder-rename-${f.id}`} title="Rename" variant="text" disabled={!online} onPress={() => setEditing({ id: f.id, name: f.name })} />
              <Button testID={`folder-delete-${f.id}`} title="Delete" variant="text" disabled={!online} accessibilityLabel={`Delete folder ${f.name}`} onPress={() => confirmDelete(f)} />
            </View>
          ),
        )}
      </View>
      {folders.data && canCreateFolder(items.length) ? (
        <>
          <NameInput testID="folder-new-name" label="New folder name" value={name} onChange={setName} />
          <Button testID="folder-new" title="New folder" disabled={!online || name.trim() === ''} busy={busy} onPress={() => void make()} />
        </>
      ) : folders.data ? (
        <Text style={{ color: t.color.textSecondary }}>{FOLDER_COPY.folder_limit_reached}</Text>
      ) : null}
      <ErrorText message={error} />
      <Button title="Done" variant="text" onPress={close} />
    </Sheet>
  );
}
