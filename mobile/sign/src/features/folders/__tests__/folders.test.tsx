// SIGN-FREE-PARITY-1 S7 — folders in the app: the chip filter over the merged Agreements list,
// the routes a move uses (same as the web), and the shared refusal copy.
import { fireEvent, render, screen } from '@testing-library/react-native';
import { FOLDER_COPY } from '@aramo/sign-client';

import { mergeAgreements } from '../../inbox/agreementsModel';
import { received, sent, workspaceWith } from '../../inbox/__tests__/fixtures';
import { FolderChips } from '../FolderChips';
import { createFolder, moveToFolder, removeFromFolder } from '../foldersApi';
import { chosenFolder, folderTargetFor, inFolder, rowFolderId } from '../foldersModel';

jest.setTimeout(30_000);

const F1 = { id: 'f0000000-0000-4000-8000-000000000001', name: 'Leases', created_at: '', updated_at: '', sender_items: 1, recipient_items: 1 };

describe('folder filter (Agreements)', () => {
  const rows = mergeAgreements(
    [sent('COMPLETED', { id: 'e1', subject: 'Lease', folder_id: F1.id }), sent('SENT', { id: 'e2', subject: 'Other' })],
    { waiting: [], completed: [received({ id: 'r1', subject: 'Offer', folder_id: F1.id })], other: [] },
  );

  it('keeps only the rows in the chosen folder, sent and received alike', () => {
    expect(inFolder(rows, F1.id).map((r) => r.subject).sort()).toEqual(['Lease', 'Offer']);
    expect(inFolder(rows, null)).toHaveLength(3);
    expect(rowFolderId(rows.find((r) => r.subject === 'Other')!)).toBeNull();
  });

  it('a folder deleted elsewhere is no longer chosen', () => {
    expect(chosenFolder([F1], F1.id)).toEqual(F1);
    expect(chosenFolder([], F1.id)).toBeNull();
  });

  it('a sent row moves by envelope id; a received row by its inbox item id', () => {
    const s = rows.find((r) => r.subject === 'Lease')!;
    const r = rows.find((x) => x.subject === 'Offer')!;
    expect(folderTargetFor(s)).toEqual({ kind: 'sender', id: 'e1', subject: 'Lease', folderId: F1.id });
    expect(folderTargetFor(r)).toEqual({ kind: 'inbox', id: 'r1', subject: 'Offer', folderId: F1.id });
  });
});

describe('folder routes (the same as the web)', () => {
  it('moves and takes out through the sender and inbox routes', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 200, body: { folder_id: F1.id } }));
    await moveToFolder(workspace, { kind: 'sender', id: 'e1', subject: 'Lease', folderId: null }, F1.id);
    await moveToFolder(workspace, { kind: 'inbox', id: 'r1', subject: 'Offer', folderId: null }, F1.id);
    await removeFromFolder(workspace, { kind: 'inbox', id: 'r1', subject: 'Offer', folderId: F1.id });
    expect(net.calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ['PUT', '/v1/sign/sender/envelopes/e1/folder'],
      ['PUT', '/v1/sign/inbox/r1/folder'],
      ['DELETE', '/v1/sign/inbox/r1/folder'],
    ]);
    expect(net.calls[0]!.body).toEqual({ folder_id: F1.id });
  });

  it('a refused name shows the shared copy', async () => {
    const { workspace } = workspaceWith(() => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR', details: { reason: 'folder_name_taken' } } } }));
    expect(await createFolder(workspace, 'Leases')).toEqual({ ok: false, message: FOLDER_COPY.folder_name_taken });
  });
});

describe('FolderChips', () => {
  it('chooses a folder, any folder, or opens Folders', () => {
    const onChange = jest.fn();
    const onManage = jest.fn();
    render(<FolderChips folders={[F1]} value={null} onChange={onChange} onManage={onManage} />);
    fireEvent.press(screen.getByTestId(`folder-${F1.id}`));
    expect(onChange).toHaveBeenLastCalledWith(F1.id);
    fireEvent.press(screen.getByTestId('folder-any'));
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.press(screen.getByTestId('folder-manage'));
    expect(onManage).toHaveBeenCalled();
  });

  it('with no folders yet, offers New folder only', () => {
    render(<FolderChips folders={[]} value={null} onChange={jest.fn()} onManage={jest.fn()} />);
    expect(screen.queryByTestId('folder-any')).toBeNull();
    expect(screen.getByText('New folder')).toBeTruthy();
  });
});
