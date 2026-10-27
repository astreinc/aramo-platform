// Self-sign and hosted session starts (M-A5 §3.2, §4.2): the token goes to the in-memory
// vault, and only an opaque handle is ever handed to navigation.
import { ApiError } from '../../../api/errors';
import { clearGuestTokens, takeGuestToken } from '../../../links/guestTokenVault';
import type { RootStackParamList } from '../../../navigation/types';
import { fakeSenderServer } from '../../send/__tests__/fakeSenderServer';
import { createSenderApi } from '../../send/senderApi';
import { selfSignRefusal, startSelfSign } from '../../send/selfSign';
import { hostedRefusal, startHosted } from '../startHosted';
import type { IssuedSigningSession, SenderApi } from '../../send/senderApi';

const SECRET = 'cap-token-SECRET-123';
const issued: IssuedSigningSession = {
  token: SECRET,
  signerId: 'sig-1',
  expiresAt: '2026-10-27T10:30:00Z',
};

afterEach(() => clearGuestTokens());

describe('Sign a document: self-sign orchestration (M-A5 §4)', () => {
  it('asks for the SELF session of the assigned signer and returns only a vault handle', async () => {
    const calls: unknown[] = [];
    const api: Pick<SenderApi, 'selfSignSession'> = {
      selfSignSession: async (id, signerId) => {
        calls.push([id, signerId]);
        return issued;
      },
    };
    const r = await startSelfSign(api, 'env-1', 'sig-1');
    expect(calls).toEqual([['env-1', 'sig-1']]);
    expect(r.kind).toBe('session');
    if (r.kind !== 'session') return;
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const params: RootStackParamList['GuestSigning'] = {
      handle: r.handle,
      mode: 'sign',
      origin: 'self',
      envelopeId: 'env-1',
    };
    expect(JSON.stringify(params)).not.toContain(SECRET);
    // The vault gives the token once, then forgets it.
    expect(takeGuestToken(r.handle)).toBe(SECRET);
    expect(takeGuestToken(r.handle)).toBeNull();
  });

  it('shows the server’s reason when the session is refused (never signs on an email match)', async () => {
    const refuse = (reason: string, status = 403) =>
      ({
        selfSignSession: async () => {
          throw new ApiError({ status, code: 'X', reason });
        },
      }) satisfies Pick<SenderApi, 'selfSignSession'>;
    await expect(startSelfSign(refuse('not_bound_to_you'), 'e', null)).resolves.toEqual({
      kind: 'refused',
      message: selfSignRefusal(
        new ApiError({ status: 403, code: 'X', reason: 'not_bound_to_you' }),
      ),
    });
    const r = await startSelfSign(refuse('email_not_verified'), 'e', 'sig');
    expect(r).toMatchObject({
      kind: 'refused',
      message: expect.stringMatching(/Verify your account email/),
    });
  });

  it('works end to end against the sender routes: assigned signer only', async () => {
    const server = fakeSenderServer();
    const api = createSenderApi(server.workspace);
    const { id } = await api.create('S');
    let v = await api.detail(id);
    v = await api.putRecipients(id, v.etag, [
      {
        name: 'Priya',
        email: 'priya@northwind.example',
        recipient_kind: 'SIGNER',
        assign_to_me: true,
      },
    ]);
    server.editElsewhere((e) => {
      e.status = 'SENT';
    });
    const r = await startSelfSign(api, id, v.env.recipients[0]!.id);
    expect(r.kind).toBe('session');
    const call = server.calls.find((c) => c.url.endsWith('/self-sign-session'))!;
    expect(call.headers['Authorization']).toBe('Bearer access-token');
  });
});

describe('Start in-person signing (M-A5 §3.2)', () => {
  it('stashes the HOSTED token and returns the handle and expiry only', async () => {
    const api: Pick<SenderApi, 'hostedSession'> = { hostedSession: async () => issued };
    const r = await startHosted(api, 'env-1', 'sig-1');
    expect(r).toMatchObject({ kind: 'session', expiresAt: issued.expiresAt });
    if (r.kind !== 'session') return;
    const params: RootStackParamList['HostedSigning'] = {
      handle: r.handle,
      signerName: 'Walk In',
      envelopeId: 'env-1',
      expiresAt: r.expiresAt,
    };
    expect(JSON.stringify(params)).not.toContain(SECRET);
    expect(takeGuestToken(r.handle)).toBe(SECRET);
  });

  it('maps the server’s refusals to their reasons', async () => {
    const server = fakeSenderServer();
    const api = createSenderApi(server.workspace);
    const { id } = await api.create('S');
    let v = await api.detail(id);
    v = await api.putRecipients(id, v.etag, [
      { name: 'Dana', email: 'dana@example.com', recipient_kind: 'SIGNER' },
    ]);
    const r = await startHosted(api, id, v.env.recipients[0]!.id);
    expect(r).toEqual({ kind: 'refused', message: 'This recipient doesn’t sign in person.' });
    expect(
      hostedRefusal(
        new ApiError({
          status: 403,
          code: 'ESIGN_FEATURE_NOT_AVAILABLE',
          reason: 'ESIGN_FEATURE_NOT_AVAILABLE',
        }),
      ),
    ).toBe('In-person signing isn’t included in your plan.');
    expect(hostedRefusal(new ApiError({ status: 409, code: 'X', reason: 'not_your_turn' }))).toBe(
      'It’s not this person’s turn to sign yet.',
    );
  });
});
