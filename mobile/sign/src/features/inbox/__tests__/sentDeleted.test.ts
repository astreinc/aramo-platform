// APP-DELETED-1 (UAT DEL-09) — the sender's Deleted folder through the same routes as Sign web.
import { ApiError } from '../../../api/errors';
import type { WorkspaceClient } from '../../../api/workspaceClient';
import { fetchDeletedSent, moveSentToDeleted, restoreSentEnvelope } from '../sentDeleted';

function client(impl: () => Promise<unknown>) {
  const request = jest.fn(impl);
  return { ws: { request } as unknown as WorkspaceClient, request };
}

describe('sent envelopes in Deleted', () => {
  it('lists ?folder=deleted; 403 → null (no sent group)', async () => {
    const ok = client(async () => ({ data: { items: [{ id: 'e1' }, { id: 'e2' }] } }));
    expect((await fetchDeletedSent(ok.ws))?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(ok.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/v1/sign/sender/envelopes',
      query: { folder: 'deleted', tab: 'all', limit: 200 },
    });
    const forbidden = client(async () => Promise.reject(new ApiError({ status: 403, code: 'forbidden' } as never)));
    expect(await fetchDeletedSent(forbidden.ws)).toBeNull();
    const broken = client(async () => Promise.reject(new ApiError({ status: 500, code: 'x' } as never)));
    await expect(fetchDeletedSent(broken.ws)).rejects.toBeInstanceOf(ApiError);
  });

  it('moves to Deleted and restores with the shared wording', async () => {
    const del = client(async () => ({ data: { deleted: true } }));
    expect(await moveSentToDeleted(del.ws, 'e/1')).toEqual({ kind: 'done', message: 'Moved to Deleted' });
    expect(del.request).toHaveBeenCalledWith({ method: 'POST', path: '/v1/sign/sender/envelopes/e%2F1/delete', body: {} });
    const res = client(async () => ({ data: { restored: true } }));
    expect(await restoreSentEnvelope(res.ws, 'e1')).toEqual({ kind: 'done', message: 'Envelope restored' });
    expect(res.request).toHaveBeenCalledWith({ method: 'POST', path: '/v1/sign/sender/envelopes/e1/restore', body: {} });
  });

  it('a refusal or a network failure is refused with a message, never thrown', async () => {
    const refused = client(async () => Promise.reject(new ApiError({ status: 409, code: 'envelope_not_finished' } as never)));
    const r = await moveSentToDeleted(refused.ws, 'e1');
    expect(r.kind).toBe('refused');
    expect(r.message.length).toBeGreaterThan(0);
    const net = await restoreSentEnvelope(client(async () => Promise.reject(new Error('net'))).ws, 'e1');
    expect(net.kind).toBe('refused');
  });
});
