import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_COPY } from '@aramo/sign-client';

// SIGN-FREE-PARITY-1 S7 — "Move to folder" on web: the user's own folders, the shared name rule
// and copy (@aramo/sign-client), move / take out through the server.

const list = vi.fn();
const create = vi.fn();
const moveEnvelope = vi.fn();
const removeEnvelope = vi.fn();
const moveInboxItem = vi.fn();
vi.mock('./folders-api', async (orig) => {
  const mod = await orig<typeof import('./folders-api')>();
  return {
    ...mod,
    foldersApi: {
      ...mod.foldersApi,
      list: (...a: unknown[]) => list(...a),
      create: (...a: unknown[]) => create(...a),
      moveEnvelope: (...a: unknown[]) => moveEnvelope(...a),
      removeEnvelope: (...a: unknown[]) => removeEnvelope(...a),
      moveInboxItem: (...a: unknown[]) => moveInboxItem(...a),
    },
  };
});

import { MoveToFolderDialog } from './folder-picker';

const F1 = { id: 'f0000000-0000-4000-8000-000000000001', name: 'Leases', created_at: '', updated_at: '', sender_items: 1, recipient_items: 0 };
const F2 = { id: 'f0000000-0000-4000-8000-000000000002', name: 'Tax', created_at: '', updated_at: '', sender_items: 0, recipient_items: 0 };

afterEach(() => vi.clearAllMocks());

describe('Move to folder (web)', () => {
  it('reads nothing while closed', () => {
    render(<MoveToFolderDialog target={null} onClose={() => undefined} onDone={() => undefined} toast={() => undefined} />);
    expect(list).not.toHaveBeenCalled();
  });

  it('moves an envelope into a folder and says so', async () => {
    list.mockResolvedValue({ items: [F1, F2], limit: 100, name_max: 60, can_create: true });
    moveEnvelope.mockResolvedValue({ folder_id: F2.id });
    const toast = vi.fn();
    const onDone = vi.fn();
    render(<MoveToFolderDialog target={{ kind: 'sender', id: 'env-1', subject: 'Lease', folder_id: F1.id }} onClose={() => undefined} onDone={onDone} toast={toast} />);
    await screen.findByTestId(`folder-choice-${F2.id}`);
    // The folder it is in now cannot be chosen again; it can be taken out.
    expect(screen.getByTestId(`folder-choice-${F1.id}`)).toBeDisabled();
    expect(screen.getByTestId('folder-take-out')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`folder-choice-${F2.id}`));
    await waitFor(() => expect(moveEnvelope).toHaveBeenCalledWith('env-1', F2.id));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Moved to Tax'));
    expect(onDone).toHaveBeenCalled();
  });

  it('a received document moves through the inbox route', async () => {
    list.mockResolvedValue({ items: [F1], limit: 100, name_max: 60, can_create: true });
    moveInboxItem.mockResolvedValue({ folder_id: F1.id });
    render(<MoveToFolderDialog target={{ kind: 'inbox', id: 'item-1', subject: 'Offer', folder_id: null }} onClose={() => undefined} onDone={() => undefined} toast={() => undefined} />);
    fireEvent.click(await screen.findByTestId(`folder-choice-${F1.id}`));
    await waitFor(() => expect(moveInboxItem).toHaveBeenCalledWith('item-1', F1.id));
    expect(screen.queryByTestId('folder-take-out')).toBeNull();
  });

  it('checks a new folder name with the shared rule before asking the server', async () => {
    list.mockResolvedValue({ items: [F1], limit: 100, name_max: 60, can_create: true });
    render(<MoveToFolderDialog target={{ kind: 'sender', id: 'env-1', subject: 'Lease', folder_id: null }} onClose={() => undefined} onDone={() => undefined} toast={() => undefined} />);
    fireEvent.change(await screen.findByTestId('folder-new-name'), { target: { value: 'leases' } });
    fireEvent.click(screen.getByTestId('folder-new-move'));
    expect(await screen.findByText(FOLDER_COPY.folder_name_taken)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('at the folder cap, offers no new folder and says why', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ ...F1, id: `f-${i}`, name: `F${i}` }));
    list.mockResolvedValue({ items, limit: 100, name_max: 60, can_create: false });
    render(<MoveToFolderDialog target={{ kind: 'sender', id: 'env-1', subject: 'Lease', folder_id: null }} onClose={() => undefined} onDone={() => undefined} toast={() => undefined} />);
    expect(await screen.findByText(FOLDER_COPY.folder_limit_reached)).toBeInTheDocument();
    expect(screen.queryByTestId('folder-new-name')).toBeNull();
  });
});
