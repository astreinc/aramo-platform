// Inbox claim + inbox signing (M-A2 §2.2; directive §7 copy).
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { errorFromBody } from '../../../api/errors';
import { recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import {
  claimFromLink,
  downloadTokenFromUrl,
  inboxRefusalCopy,
  signingTokenFromUrl,
  startInboxSigning,
} from '../inboxSigning';
import { BASE, workspaceWith } from './fixtures';

const LINK_ENDED =
  'This link was replaced or has expired. Open the newest email, or sign in to your inbox.';

describe('reason → copy (directive §7)', () => {
  const cases: [string, string][] = [
    [
      'association_inactive',
      'You can no longer sign this from your inbox. Open the newest email link.',
    ],
    ['envelope_not_signable', 'This envelope can’t be signed any more.'],
    ['signer_ineligible', 'You can no longer sign this envelope.'],
    ['not_your_turn', 'It’s not your turn to sign yet. You’ll get an email when it is.'],
    ['session_revoked', LINK_ENDED],
    ['link_expired', LINK_ENDED],
    ['recipient_mismatch', 'This link was sent to a different email address.'],
  ];
  it.each(cases)('%s', (reason, copy) => {
    const e = errorFromBody(409, { error: { code: 'CONFLICT', details: { reason } } });
    expect(inboxRefusalCopy(e)).toBe(copy);
  });

  it('falls back to the shared copy for anything else', () => {
    expect(inboxRefusalCopy({ reason: 'network_unavailable', code: 'network_unavailable' })).toBe(
      'You’re offline. Check your connection and try again.',
    );
  });
});

describe('signing links', () => {
  it('extracts the token only from /s/{token} (and /d/ for the signed copy)', () => {
    expect(signingTokenFromUrl(`https://sign.aramo.ai/s/${SIGNING_TOKEN}`)).toBe(SIGNING_TOKEN);
    expect(signingTokenFromUrl(`https://sign.aramo.ai/d/${SIGNING_TOKEN}`)).toBeNull();
    expect(signingTokenFromUrl('https://sign.aramo.ai/s/short')).toBeNull();
    expect(downloadTokenFromUrl(`https://sign.aramo.ai/d/${SIGNING_TOKEN}`)).toBe(SIGNING_TOKEN);
  });
});

describe('claim (workspace call by contract)', () => {
  it('POSTs the emailed token to /v1/sign/inbox/claim with workspace credentials', async () => {
    const { net, workspace } = workspaceWith(() => ({ status: 201, body: { id: 'b1' } }));
    expect(await claimFromLink(workspace, SIGNING_TOKEN)).toEqual({ id: 'b1' });
    expect(net.calls[0]!.url).toBe(`${BASE}/v1/sign/inbox/claim`);
    expect(net.calls[0]!.body).toEqual({ token: SIGNING_TOKEN });
    expect(net.calls[0]!.headers['Authorization']).toMatch(/^Bearer /);
  });

  it('a different email is refused with recipient_mismatch', async () => {
    const { workspace } = workspaceWith(() => ({
      status: 403,
      body: {
        error: { code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'recipient_mismatch' } },
      },
    }));
    await expect(claimFromLink(workspace, SIGNING_TOKEN)).rejects.toMatchObject({
      reason: 'recipient_mismatch',
    });
  });
});

describe('inbox signing (revalidated every time)', () => {
  it('mints on the workspace client, then signs on the guest transport without Authorization', async () => {
    const { net: wsNet, workspace } = workspaceWith(() => ({
      status: 200,
      body: {
        signing_url: `https://sign.aramo.ai/s/${SIGNING_TOKEN}`,
        expires_at: '2026-10-20T12:30:00.000Z',
      },
    }));
    const guestNet = recordingFetch(() => ({ status: 200, body: {} }));
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: guestNet.fetch });
    const r = await startInboxSigning(workspace, guest, 'item-1');
    expect(r.kind).toBe('session');
    expect(wsNet.calls[0]!.url).toBe(`${BASE}/v1/sign/inbox/item-1/sign`);
    if (r.kind !== 'session') return;
    await r.session.post('/v1/sign/signing/exchange', {});
    const g = guestNet.calls[0]!;
    expect(Object.keys(g.headers).some((h) => h.toLowerCase() === 'authorization')).toBe(false);
    expect(g.body?.['token']).toBe(SIGNING_TOKEN);
  });

  it.each([
    'association_inactive',
    'envelope_not_signable',
    'signer_ineligible',
    'not_your_turn',
    'session_revoked',
  ])('refusal %s is shown, no session is opened', async (reason) => {
    const { workspace } = workspaceWith(() => ({
      status: 409,
      body: { error: { code: 'CONFLICT', details: { reason } } },
    }));
    const guest = { open: jest.fn() };
    const r = await startInboxSigning(workspace, guest, 'item-1');
    expect(r).toMatchObject({ kind: 'refused', reason });
    expect(guest.open).not.toHaveBeenCalled();
  });
});
