import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import { hashSigningToken, InboxSigningRefusedError, type InboxSigningRefusal } from '@aramo/sign';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecipientInboxController } from '../app/inbox/recipient-inbox.controller.js';
import { RecipientInboxService } from '../app/inbox/recipient-inbox.service.js';

// Sign Unified Product S-7 (directive §4.6, mandatory refinement B) — the
// recipient inbox: recipient-specific binding, recipient-only cross-tenant access.

const USER = '11111111-1111-7111-8111-111111111111';
const USER_TENANT = '22222222-2222-7222-8222-222222222222';
const SENDER_TENANT = '33333333-3333-7333-8333-333333333333';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789';
const auth: AuthContextType = { sub: USER, consumer_type: 'sign', actor_kind: 'user', tenant_id: USER_TENANT, scopes: [], iat: 0, exp: 0 };

let savedBase: string | undefined;
beforeEach(() => {
  savedBase = process.env['ARAMO_SIGN_BASE_URL'];
  process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.example.test';
});
afterEach(() => {
  if (savedBase === undefined) delete process.env['ARAMO_SIGN_BASE_URL'];
  else process.env['ARAMO_SIGN_BASE_URL'] = savedBase;
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  envelope_tenant_id: SENDER_TENANT,
  envelope_id: 'e1',
  signer_id: 's1',
  created_at: new Date(),
  envelope: { subject: 'Offer letter', status: 'SENT', sent_at: new Date(), completed_at: null, expires_at: new Date(Date.now() + 86_400_000) },
  signer: { name: 'Bob', status: 'PENDING', signed_at: null },
  ...over,
});

function service(opts: { session?: Record<string, unknown> | null; email?: string | null; rows?: unknown[]; one?: unknown; refuse?: InboxSigningRefusal } = {}) {
  const repo = {
    sessionForToken: vi.fn(async (h: string) =>
      h === hashSigningToken(TOKEN) && opts.session !== null
        ? { id: 'sess-claimed', tenant_id: SENDER_TENANT, envelope_id: 'e1', signer_id: 's1', status: 'ISSUED', expires_at: new Date(Date.now() + 60_000), signer_email: 'Bob@Example.TEST', ...opts.session }
        : null,
    ),
    bind: vi.fn(async () => ({ id: 'b1' })),
    listForUser: vi.fn(async () => opts.rows ?? [row()]),
    getForUser: vi.fn(async () => (opts.one === undefined ? row() : opts.one)),
    issueRevalidatedRecipientSession: vi.fn(async () => {
      if (opts.refuse !== undefined) throw new InboxSigningRefusedError(opts.refuse);
      return opts.one === null ? null : { raw_token: 'rawsession', session_id: 'sess-inbox', expires_at: new Date('2026-10-25T10:30:00.000Z') };
    }),
    issueRecipientCopyAccess: vi.fn(async () => 'rawcopy'),
    revoke: vi.fn(async () => false),
  };
  const identity = {
    findUserById: vi.fn(async () => (opts.email === null ? null : { id: USER, email: opts.email ?? 'bob@example.test' })),
    findTenantNameById: vi.fn(async () => ({ name: 'northwind', display_name: 'Northwind Staffing' })),
  };
  return { svc: new RecipientInboxService(repo as never, identity as never), repo };
}

describe('binding — a live signing link AND the user’s verified email, never an email match alone', () => {
  it('binds when both hold; tenant and envelope come from the signing session, the user’s tenant from the token', async () => {
    const { svc, repo } = service();
    await expect(svc.claim(auth, { token: TOKEN }, 'r')).resolves.toEqual({ id: 'b1' });
    // Sign Mobile M-A2 §2.2 — the claim records the emailed session it was made with.
    expect(repo.bind).toHaveBeenCalledWith({
      envelope_tenant_id: SENDER_TENANT, envelope_id: 'e1', signer_id: 's1', user_id: USER, user_tenant_id: USER_TENANT, email: 'bob@example.test', claim_session_id: 'sess-claimed',
    });
  });

  it('a different email address is refused even with a valid link', async () => {
    const { svc, repo } = service({ email: 'carol@example.test' });
    await expect(svc.claim(auth, { token: TOKEN }, 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'recipient_mismatch' } } });
    expect(repo.bind).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown link', { session: null }],
    ['revoked link', { session: { status: 'REVOKED' } }],
    ['expired link', { session: { status: 'EXPIRED' } }],
    ['past its time', { session: { expires_at: new Date(Date.now() - 1) } }],
  ])('%s → one answer, 401', async (_n, opts) => {
    const { svc, repo } = service(opts as never);
    await expect(svc.claim(auth, { token: TOKEN }, 'r')).rejects.toMatchObject({ statusCode: 401, code: 'SIGNING_SESSION_INVALID' });
    expect(repo.bind).not.toHaveBeenCalled();
  });

  it('a malformed body is refused', async () => {
    await expect(service().svc.claim(auth, { token: 42 }, 'r')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('recipient-only access', () => {
  it('lists only the user’s bindings, exposing nothing of the sender tenant beyond its name', async () => {
    const { svc, repo } = service();
    const out = await svc.list(auth);
    expect(repo.listForUser).toHaveBeenCalledWith(USER);
    expect(Object.keys(out.waiting[0]!).sort()).toEqual(
      ['can_download', 'can_sign', 'completed_at', 'envelope_expires_at', 'envelope_status', 'expires_at', 'from', 'id', 'my_status', 'sent_at', 'signed_at', 'signing_link_valid_days', 'subject'].sort(),
    );
    expect(JSON.stringify(out)).not.toContain(SENDER_TENANT);
    expect(JSON.stringify(out)).not.toContain('"e1"');
    expect(out.waiting[0]).toMatchObject({ from: 'Northwind Staffing', can_sign: true });
  });

  it('another user’s binding reads as not found', async () => {
    await expect(service({ one: null }).svc.sign(auth, 'b9', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('signing issues a fresh short-lived link for that recipient, keyed by the caller', async () => {
    const { svc, repo } = service();
    await expect(svc.sign(auth, 'b1', 'r')).resolves.toEqual({ signing_url: 'https://sign.example.test/s/rawsession', expires_at: '2026-10-25T10:30:00.000Z' });
    expect(repo.issueRevalidatedRecipientSession).toHaveBeenCalledWith(USER, 'b1');
  });

  // Sign Mobile M-A2 §2.2 — every refusal of the transactional revalidation is a 409
  // with its stable reason; the C-21 recovery copy for a replaced or expired link.
  it.each<InboxSigningRefusal>(['association_inactive', 'envelope_not_signable', 'signer_ineligible', 'not_your_turn', 'session_revoked', 'link_expired'])(
    'revalidation refusal %s → 409 with that reason',
    async (reason) => {
      await expect(service({ refuse: reason }).svc.sign(auth, 'b1', 'r')).rejects.toMatchObject({ statusCode: 409, code: 'ENVELOPE_ILLEGAL_TRANSITION', context: { details: { reason } } });
    },
  );

  it('a replaced or expired claimed link shows the recovery message', async () => {
    await expect(service({ refuse: 'session_revoked' }).svc.sign(auth, 'b1', 'r')).rejects.toMatchObject({
      message: 'This link was replaced or has expired. Open the newest email, or sign in to your inbox.',
    });
  });

  it('a signed copy only once complete and signed by this recipient', async () => {
    await expect(service().svc.signedCopy(auth, 'b1', 'r')).rejects.toMatchObject({ statusCode: 409 });
    const done = row({ envelope: { ...row().envelope, status: 'COMPLETED', completed_at: new Date() }, signer: { name: 'Bob', status: 'SIGNED', signed_at: new Date() } });
    await expect(service({ one: done }).svc.signedCopy(auth, 'b1', 'r')).resolves.toEqual({ download_url: 'https://sign.example.test/d/rawcopy' });
  });

  it('removing an unknown binding is not found', async () => {
    await expect(service().svc.remove(auth, 'b1', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('route metadata — a recipient right, not a tenant permission', () => {
  const h = (n: string): object => (RecipientInboxController.prototype as unknown as Record<string, object>)[n] ?? {};
  it.each(['list', 'claim', 'sign', 'signedCopy', 'remove'])('%s: session + esign consumer, no Sign scope required', (n) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, h(n))).toEqual([JwtAuthGuard, EsignSenderConsumerGuard]);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, h(n))).toBeUndefined();
  });
});
