// M-A17 (UAT SIG-15 retest) — the app reads the recipient's own Deleted folder and restores
// through the same routes as the web (Waiting for me → Show deleted → Restore).
import { ApiError } from '../../../api/errors';
import type { WorkspaceClient } from '../../../api/workspaceClient';
import { fetchDeletedInbox, restoreInboxItem } from '../deletedInbox';

function client(impl: () => Promise<unknown>) {
  const request = jest.fn(impl);
  return { ws: { request } as unknown as WorkspaceClient, request };
}

describe('deleted inbox', () => {
  it('lists every deleted item (waiting, completed, other) from ?folder=deleted', async () => {
    const { ws, request } = client(async () => ({
      data: { waiting: [{ id: 'a' }], completed: [{ id: 'b' }], other: [{ id: 'c' }] },
    }));
    expect((await fetchDeletedInbox(ws)).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(request).toHaveBeenCalledWith({ method: 'GET', path: '/v1/sign/inbox?folder=deleted' });
  });

  it('restores with return-to-inbox; 404 → gone, anything else → failed', async () => {
    const ok = client(async () => ({ data: { restored: true } }));
    expect(await restoreInboxItem(ok.ws, 'item/1')).toBe('restored');
    expect(ok.request).toHaveBeenCalledWith({ method: 'POST', path: '/v1/sign/inbox/item%2F1/return-to-inbox', body: {} });
    const err = (status: number) => new ApiError({ status, code: 'X' } as never);
    expect(await restoreInboxItem(client(async () => Promise.reject(err(404))).ws, 'i')).toBe('gone');
    expect(await restoreInboxItem(client(async () => Promise.reject(new Error('net'))).ws, 'i')).toBe('failed');
  });
});
