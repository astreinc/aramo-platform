import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintInboxHandle } from '@aramo/sign';

import { RecipientInboxService } from '../app/inbox/recipient-inbox.service.js';

// Aramo-Sign-Mobile-Amendment-M-A17 — "Delete from my inbox": any received item (a claimed
// id or a discovered handle), any state, to this user's Deleted folder; Restore brings it
// back; nothing else changes and no purge is involved.

const USER = '11111111-1111-4111-8111-111111111111';
const BOUND_ID = '22222222-2222-4222-8222-222222222222';
const SIGNER_BOUND = '33333333-3333-4333-8333-333333333333';
const SIGNER_FOUND = '44444444-4444-4444-8444-444444444444';
const auth = { sub: USER, tenant_id: 't-user' } as never;
const KEY = randomBytes(32);

const entry = (signer_id: string, envelope_id: string) => ({ id: signer_id, signer_id, envelope_id, envelope_tenant_id: 't-env', envelope: { status: 'SENT' }, signer: {} });

function serviceWith() {
  const repo = {
    getForUser: vi.fn(async (_u: string, id: string) => (id === BOUND_ID ? entry(SIGNER_BOUND, 'env-b') : null)),
    verifiedEmailProof: vi.fn(async () => ({ email: 'pat@example.test', proven_at: new Date(0) })),
    listDiscoveredForUser: vi.fn(async () => [entry(SIGNER_FOUND, 'env-f')]),
    removeFromInbox: vi.fn(async () => undefined),
    returnToInbox: vi.fn(async () => true),
  };
  const svc = new RecipientInboxService(repo as never, {} as never);
  return { svc, repo };
}

describe('M-A17 — Delete from my inbox', () => {
  beforeEach(() => vi.stubEnv('SIGN_INBOX_HANDLE_KEY', KEY.toString('base64')));
  afterEach(() => vi.unstubAllEnvs());

  it('a claimed item (by id) and a discovered item (by handle) are both deleted for this user only', async () => {
    const { svc, repo } = serviceWith();
    expect(await svc.removeFromInbox(auth, BOUND_ID, 'r')).toEqual({ removed: true });
    expect(repo.removeFromInbox).toHaveBeenLastCalledWith(USER, expect.objectContaining({ signer_id: SIGNER_BOUND, envelope_id: 'env-b' }));
    const handle = mintInboxHandle(KEY, { signer_id: SIGNER_FOUND, user_id: USER });
    expect(await svc.removeFromInbox(auth, handle, 'r')).toEqual({ removed: true });
    expect(repo.removeFromInbox).toHaveBeenLastCalledWith(USER, expect.objectContaining({ signer_id: SIGNER_FOUND, envelope_id: 'env-f' }));
  });

  it('restore brings it back', async () => {
    const { svc, repo } = serviceWith();
    expect(await svc.returnToInbox(auth, BOUND_ID, 'r')).toEqual({ restored: true });
    expect(repo.returnToInbox).toHaveBeenCalledWith(USER, SIGNER_BOUND);
  });

  it('anything the user cannot see is 404 (another user’s handle, an unknown id)', async () => {
    const { svc, repo } = serviceWith();
    const foreign = mintInboxHandle(KEY, { signer_id: SIGNER_FOUND, user_id: '99999999-9999-4999-8999-999999999999' });
    await expect(svc.removeFromInbox(auth, foreign, 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.removeFromInbox(auth, '55555555-5555-4555-8555-555555555555', 'r')).rejects.toMatchObject({ statusCode: 404 });
    expect(repo.removeFromInbox).not.toHaveBeenCalled();
  });
});
