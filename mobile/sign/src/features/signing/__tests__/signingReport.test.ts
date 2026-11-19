// UAT SIG-14 (M-A7 §5.2) — "Report this envelope" from the app's signing screen: the
// same public report route and reasons as the web, with this signing token only.
import { createGuestSigningClient } from '../../../api/guestSigningClient';
import { recordingFetch, SIGNING_TOKEN } from '../../../testing/fakes';
import { reportFromSigning, SIGNING_REPORT_COPY } from '../signingApi';

const BASE = 'https://sign.example.test';

function sessionAnswering(status: number) {
  const net = recordingFetch(() => ({ status, body: status < 300 ? { status: 'accepted' } : { error: { code: 'X', message: 'x' } } }));
  const session = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
  return { net, session };
}

describe('report from the signing screen', () => {
  it('posts the reason with this signing token to /v1/sign/report — no credentials', async () => {
    const { net, session } = sessionAnswering(202);
    expect(await reportFromSigning(session, 'phishing')).toBe('sent');
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url.replace(BASE, '')).toBe('/v1/sign/report');
    expect(net.calls[0]!.body).toEqual({ reason: 'phishing', token: SIGNING_TOKEN });
    expect(Object.keys(net.calls[0]!.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(SIGNING_REPORT_COPY.sent).toBe('Thanks — we’ll look into it.');
  });

  it('sends the optional note, and nothing for an empty reason or note (as the web)', async () => {
    const withNote = sessionAnswering(202);
    expect(await reportFromSigning(withNote.session, 'phishing', 'Asked for my bank login')).toBe('sent');
    expect(withNote.net.calls[0]!.body).toEqual({ reason: 'phishing', note: 'Asked for my bank login', token: SIGNING_TOKEN });
    const bare = sessionAnswering(202);
    expect(await reportFromSigning(bare.session, null, '')).toBe('sent');
    expect(bare.net.calls[0]!.body).toEqual({ token: SIGNING_TOKEN });
  });

  it('maps the server answers as the web report page does', async () => {
    expect(await reportFromSigning(sessionAnswering(409).session, 'spam')).toBe('already');
    for (const s of [400, 404, 410]) expect(await reportFromSigning(sessionAnswering(s).session, 'spam')).toBe('invalid');
    expect(await reportFromSigning(sessionAnswering(429).session, 'spam')).toBe('limited');
    expect(await reportFromSigning(sessionAnswering(500).session, 'spam')).toBe('failed');
  });

  it('the guest transport still refuses any other non-signing path', async () => {
    const { session } = sessionAnswering(200);
    await expect(session.postRaw('/v1/sign/sender/envelopes' as never, {})).rejects.toThrow('only signing paths');
  });
});
