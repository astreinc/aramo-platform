// Amendment M-A7 §5.2 (R-11) — the app's report reaches POST /v1/sign/inbox/:id/report
// (workspace client; the inbox item id in the path, never a signing token).
import { ApiError } from '../../../api/errors';
import type { WorkspaceClient } from '../../../api/workspaceClient';
import { REPORT_REASONS, reportInboxItem } from '../inboxReport';

function client(impl: () => Promise<unknown>) {
  const call = jest.fn(impl);
  return { ws: { call } as unknown as WorkspaceClient, call };
}

describe('reportInboxItem', () => {
  it('posts the reason for the inbox item', async () => {
    const { ws, call } = client(async () => ({ received: true }));
    await expect(reportInboxItem(ws, 'item-1', 'phishing')).resolves.toBe('sent');
    expect(call).toHaveBeenCalledWith('/v1/sign/inbox/{id}/report', 'post', { path: { id: 'item-1' }, body: { reason: 'phishing' } });
  });

  it('maps 409 → already, 404 → gone, anything else → failed', async () => {
    const err = (status: number) => new ApiError({ status, code: 'X', reason: 'already_reported' } as never);
    await expect(reportInboxItem(client(async () => Promise.reject(err(409))).ws, 'i', 'spam')).resolves.toBe('already');
    await expect(reportInboxItem(client(async () => Promise.reject(err(404))).ws, 'i', 'spam')).resolves.toBe('gone');
    await expect(reportInboxItem(client(async () => Promise.reject(new Error('net'))).ws, 'i', 'spam')).resolves.toBe('failed');
  });

  it('offers the same reasons as the web report page', () => {
    expect(REPORT_REASONS.map((r) => r.key)).toEqual(['phishing', 'impersonation', 'spam', 'other']);
  });
});
