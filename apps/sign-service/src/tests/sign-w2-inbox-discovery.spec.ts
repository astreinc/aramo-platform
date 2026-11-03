import 'reflect-metadata';
import { randomBytes } from 'node:crypto';

import type { AuthContextType } from '@aramo/auth';
import { INBOX_HANDLE_KEY_ENV, INBOX_HANDLE_TTL_MS, InboxSigningRefusedError, type InboxSigningRefusal, mintInboxHandle, openInboxHandle } from '@aramo/sign';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RecipientInboxService } from '../app/inbox/recipient-inbox.service.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// Aramo Sign W2 — Aramo-Sign-W2-Inbox-Discovery-Gate5-Plan-and-Amendment-v1_0-LOCKED §A3, §A5.
// The service half: actionable vs upcoming (R-1), dedupe, the opaque handle (C3) and its
// refusals, the key-absent fail-closed mode, and the sender list's awaiting_you. The
// discovery rule itself (C1, C2, normalization, kinds) is proven on real Postgres in
// libs/sign/src/tests/inbox-discovery.integration.spec.ts.

const USER = '11111111-1111-7111-8111-111111111111';
const OTHER_USER = '44444444-4444-7444-8444-444444444444';
const USER_TENANT = '22222222-2222-7222-8222-222222222222';
const SENDER_TENANT = '33333333-3333-7333-8333-333333333333';
const ENVELOPE = 'e1000000-0000-7000-8000-000000000001';
const BOUND_SIGNER = 'a1000000-0000-7000-8000-000000000001';
const FOUND_SIGNER = 'a2000000-0000-7000-8000-000000000002';
const BINDING = 'b1000000-0000-7000-8000-000000000001';
const auth = (sub = USER): AuthContextType => ({ sub, consumer_type: 'sign', actor_kind: 'user', tenant_id: USER_TENANT, scopes: [], iat: 0, exp: 0 });
const KEY = randomBytes(32);
const PROOF = { email: 'dana@example.test', proven_at: new Date('2026-10-01T00:00:00.000Z') };

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = { base: process.env['ARAMO_SIGN_BASE_URL'], key: process.env[INBOX_HANDLE_KEY_ENV] };
  process.env['ARAMO_SIGN_BASE_URL'] = 'https://sign.example.test';
  process.env[INBOX_HANDLE_KEY_ENV] = KEY.toString('base64');
});
afterEach(() => {
  vi.useRealTimers();
  for (const [k, env] of [['base', 'ARAMO_SIGN_BASE_URL'], ['key', INBOX_HANDLE_KEY_ENV]] as const) {
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
  }
});

type Entry = Record<string, unknown> & { signer_id: string; envelope_id: string };
const entry = (over: Partial<Entry> & { envelope?: Record<string, unknown>; signer?: Record<string, unknown> } = {}): Entry => {
  const { envelope, signer, ...rest } = over;
  return {
    id: BINDING,
    source: 'bound',
    turn: 'now',
    link_live: true,
    envelope_tenant_id: SENDER_TENANT,
    envelope_id: ENVELOPE,
    signer_id: BOUND_SIGNER,
    created_at: new Date(),
    envelope: { subject: 'Offer letter', status: 'SENT', sent_at: new Date(), completed_at: null, expires_at: new Date(Date.now() + 86_400_000), purge_state: null, ...envelope },
    signer: { name: 'Dana', status: 'PENDING', signed_at: null, ...signer },
    ...rest,
  };
};
const found = (over: Parameters<typeof entry>[0] = {}): Entry => entry({ id: FOUND_SIGNER, source: 'discovered', signer_id: FOUND_SIGNER, ...over });

function inbox(opts: { bound?: Entry[]; discovered?: Entry[]; proof?: typeof PROOF | null; refuse?: InboxSigningRefusal; deleted?: string[] } = {}) {
  const repo = {
    listForUser: vi.fn(async () => opts.bound ?? []),
    verifiedEmailProof: vi.fn(async () => (opts.proof === undefined ? PROOF : opts.proof)),
    listDiscoveredForUser: vi.fn(async () => opts.discovered ?? []),
    issueDiscoveredRecipientSession: vi.fn(async () => {
      if (opts.refuse !== undefined) throw new InboxSigningRefusedError(opts.refuse);
      return { raw_token: 'rawsession', session_id: 'sess-inbox', expires_at: new Date('2026-11-03T10:30:00.000Z') };
    }),
    issueRevalidatedRecipientSession: vi.fn(async () => ({ raw_token: 'rawbound', session_id: 'sess-b', expires_at: new Date('2026-11-03T10:30:00.000Z') })),
  };
  const identity = { findTenantNameById: vi.fn(async () => ({ name: 'northwind', display_name: 'Northwind Staffing' })) };
  const purges = opts.deleted === undefined ? undefined : { deletedEnvelopeIds: vi.fn(async () => opts.deleted ?? []) };
  return { svc: new RecipientInboxService(repo as never, identity as never, purges as never), repo };
}
const all = (o: { waiting: unknown[]; completed: unknown[]; other: unknown[] }) => [...o.waiting, ...o.completed, ...o.other] as Array<Record<string, unknown>>;

describe('W2 §A3.2 — can_sign = turn + witness readiness + signable + unexpired + live link (bound and discovered)', () => {
  it.each(['bound', 'discovered'] as const)('%s, actionable → waiting, can_sign', async (source) => {
    const e = source === 'bound' ? entry() : found();
    const out = await inbox(source === 'bound' ? { bound: [e] } : { discovered: [e] }).svc.list(auth());
    expect(out.waiting).toHaveLength(1);
    expect(out.waiting[0]).toMatchObject({ source, can_sign: true, my_status: 'PENDING' });
  });

  // Row 4 — SEQUENTIAL, U second (also a witness before its signer): upcoming, never Needs Me.
  it.each(['bound', 'discovered'] as const)('row 4: %s, turn later → my_status upcoming, can_sign false, listed in waiting', async (source) => {
    const e = source === 'bound' ? entry({ turn: 'later', link_live: false }) : found({ turn: 'later', link_live: false });
    const out = await inbox(source === 'bound' ? { bound: [e] } : { discovered: [e] }).svc.list(auth());
    expect(out.waiting).toHaveLength(1);
    expect(out.waiting[0]).toMatchObject({ my_status: 'upcoming', can_sign: false });
    expect(out.other).toHaveLength(0);
  });

  it('row 17 (W-3): turn now but no live emailed link → not signable (other)', async () => {
    const out = await inbox({ bound: [entry({ link_live: false })], discovered: [found({ link_live: false })] }).svc.list(auth());
    expect(out.waiting).toHaveLength(0);
    expect(out.other.map((i) => i.can_sign)).toEqual([false, false]);
  });

  it('row 6: U already signed, others pending → off Needs Me', async () => {
    const out = await inbox({ discovered: [found({ envelope: { status: 'IN_PROGRESS' }, signer: { status: 'SIGNED', signed_at: new Date() } })] }).svc.list(auth());
    expect(out.waiting).toHaveLength(0);
    expect(out.other[0]).toMatchObject({ my_status: 'SIGNED', can_sign: false });
  });

  it.each(['COMPLETED', 'VOIDED', 'EXPIRED', 'DECLINED'])('row 7: %s → not signable, never upcoming', async (status) => {
    const out = await inbox({ bound: [entry({ turn: 'later', envelope: { status } })] }).svc.list(auth());
    expect(out.waiting).toHaveLength(0);
    expect(all(out)[0]).toMatchObject({ can_sign: false });
    expect(all(out)[0]!['my_status']).not.toBe('upcoming');
  });

  it('an envelope past its expiry is not signable even while still SENT', async () => {
    const out = await inbox({ bound: [entry({ envelope: { expires_at: new Date(Date.now() - 1) } })] }).svc.list(auth());
    expect(out.waiting).toHaveLength(0);
  });

  it('row 7: a bound COMPLETED item I signed is downloadable (Completed); a discovered one lists under other (no handle download route)', async () => {
    const done = { envelope: { status: 'COMPLETED', completed_at: new Date() }, signer: { status: 'SIGNED', signed_at: new Date() } };
    const out = await inbox({ bound: [entry(done)], discovered: [found({ ...done, signer_id: FOUND_SIGNER })] }).svc.list(auth());
    expect(out.completed.map((i) => i.source)).toEqual(['bound']);
    expect(out.other.map((i) => i.source)).toEqual(['discovered']);
  });
});

describe('W2 §A3.1 / §A3.4 — discovered items and their handles', () => {
  it('row 3 / 14: a discovered item carries an opaque handle, never a signer, envelope or tenant id', async () => {
    const out = await inbox({ discovered: [found()] }).svc.list(auth());
    const item = out.waiting[0]!;
    expect(item.source).toBe('discovered');
    expect(item.id).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const json = JSON.stringify(out);
    for (const secret of [FOUND_SIGNER, ENVELOPE, SENDER_TENANT, PROOF.email]) expect(json).not.toContain(secret);
    expect(Object.keys(item)).not.toContain('envelope_id');
  });

  it('every list issues fresh handles (30-minute, user-bound)', async () => {
    const { svc } = inbox({ discovered: [found()] });
    const a = (await svc.list(auth())).waiting[0]!.id;
    const b = (await svc.list(auth())).waiting[0]!.id;
    expect(a).not.toBe(b);
  });

  it('rows 2 / 8: dedupe — a recipient reachable through a binding is listed once, as bound', async () => {
    const { svc } = inbox({ bound: [entry({ signer_id: FOUND_SIGNER })], discovered: [found()] });
    const out = await svc.list(auth());
    expect(all(out)).toHaveLength(1);
    expect(all(out)[0]).toMatchObject({ source: 'bound', id: BINDING });
  });

  it('rows 11 / 18 / 19: no proof of the current email (inactive, admin-created link, changed email) → nothing discovered', async () => {
    const { svc, repo } = inbox({ proof: null, discovered: [found()] });
    expect(all(await svc.list(auth()))).toHaveLength(0);
    expect(repo.listDiscoveredForUser).not.toHaveBeenCalled();
  });

  it('the repository is asked with the proof (rules 2-5 run there) and the caller id', async () => {
    const { svc, repo } = inbox({ discovered: [found()] });
    await svc.list(auth());
    expect(repo.verifiedEmailProof).toHaveBeenCalledWith(USER);
    expect(repo.listDiscoveredForUser).toHaveBeenCalledWith(USER, PROOF, expect.any(Date));
  });

  it("rule 6: a recipient's party deletion applies to discovered items too", async () => {
    const out = await inbox({ discovered: [found()], deleted: [ENVELOPE] }).svc.list(auth());
    expect(all(out)).toHaveLength(0);
    const del = await inbox({ discovered: [found()], deleted: [ENVELOPE] }).svc.list(auth(), 'deleted');
    expect(all(del)).toHaveLength(1);
  });

  it('row 26: SIGN_INBOX_HANDLE_KEY absent → discovery off, bound items unchanged', async () => {
    delete process.env[INBOX_HANDLE_KEY_ENV];
    const { svc, repo } = inbox({ bound: [entry()], discovered: [found()] });
    const out = await svc.list(auth());
    expect(all(out).map((i) => i.source)).toEqual(['bound']);
    expect(repo.verifiedEmailProof).not.toHaveBeenCalled();
    expect(repo.listDiscoveredForUser).not.toHaveBeenCalled();
  });

  it.each([
    ['short', 'AAAA'],
    ['not 32 bytes', randomBytes(16).toString('base64')],
  ])('a %s key is no key (fail closed)', async (_n, k) => {
    process.env[INBOX_HANDLE_KEY_ENV] = k;
    const { svc, repo } = inbox({ discovered: [found()] });
    expect(all(await svc.list(auth()))).toHaveLength(0);
    expect(repo.listDiscoveredForUser).not.toHaveBeenCalled();
  });
});

describe('W2 (orchestrator addition) — inbox i_am_sender', () => {
  it('true only when the envelope was created by the signed-in user; never exposes the creator id', async () => {
    const out = await inbox({
      bound: [entry({ envelope: { created_by: USER } })],
      discovered: [found({ envelope: { created_by: OTHER_USER } })],
    }).svc.list(auth());
    expect(all(out).map((i) => [i.source, i.i_am_sender])).toEqual([['bound', true], ['discovered', false]]);
    expect(JSON.stringify(out)).not.toContain(OTHER_USER);
    expect(JSON.stringify(out)).not.toContain('created_by');
  });

  it('another user reading their own inbox never sees i_am_sender true for my envelope', async () => {
    const out = await inbox({ discovered: [found({ envelope: { created_by: USER } })] }).svc.list(auth(OTHER_USER));
    expect(all(out)[0]!.i_am_sender).toBe(false);
  });
});

describe('W2 §A3.3 — POST /v1/sign/inbox/{handle}/sign', () => {
  const handle = (user_id = USER, now = new Date()) => mintInboxHandle(KEY, { signer_id: FOUND_SIGNER, user_id }, now);

  it('a valid handle mints through the binding-less revalidating path; same response shape as a bound item', async () => {
    const { svc, repo } = inbox();
    await expect(svc.sign(auth(), handle(), 'r')).resolves.toEqual({ signing_url: 'https://sign.example.test/s/rawsession', expires_at: '2026-11-03T10:30:00.000Z' });
    expect(repo.issueDiscoveredRecipientSession).toHaveBeenCalledWith(USER, FOUND_SIGNER);
    expect(repo.issueRevalidatedRecipientSession).not.toHaveBeenCalled();
  });

  it('a binding id still takes the binding path', async () => {
    const { svc, repo } = inbox();
    await svc.sign(auth(), BINDING, 'r');
    expect(repo.issueRevalidatedRecipientSession).toHaveBeenCalledWith(USER, BINDING);
    expect(repo.issueDiscoveredRecipientSession).not.toHaveBeenCalled();
  });

  const notFound = { statusCode: 404, context: { details: { reason: 'inbox_item_not_found' } } };

  it('row 21: every single-character change of the handle → 404 inbox_item_not_found, nothing minted', async () => {
    const h = handle();
    const { svc, repo } = inbox();
    for (let i = 0; i < h.length; i += 1) {
      const flipped = h.slice(0, i) + (h[i] === 'A' ? 'B' : 'A') + h.slice(i + 1);
      await expect(svc.sign(auth(), flipped, 'r')).rejects.toMatchObject(notFound);
    }
    expect(repo.issueDiscoveredRecipientSession).not.toHaveBeenCalled();
  });

  it('row 22: a handle after exp → 404', async () => {
    const issued = new Date(Date.now() - INBOX_HANDLE_TTL_MS - 1000);
    const { svc, repo } = inbox();
    await expect(svc.sign(auth(), handle(USER, issued), 'r')).rejects.toMatchObject(notFound);
    expect(repo.issueDiscoveredRecipientSession).not.toHaveBeenCalled();
  });

  it('row 23: a handle issued to user A redeemed by user B → 404, nothing minted', async () => {
    const { svc, repo } = inbox();
    await expect(svc.sign(auth(OTHER_USER), handle(USER), 'r')).rejects.toMatchObject(notFound);
    expect(repo.issueDiscoveredRecipientSession).not.toHaveBeenCalled();
  });

  it('row 15: a forged handle (another key, or garbage) → 404', async () => {
    const { svc } = inbox();
    await expect(svc.sign(auth(), mintInboxHandle(randomBytes(32), { signer_id: FOUND_SIGNER, user_id: USER }), 'r')).rejects.toMatchObject(notFound);
    await expect(svc.sign(auth(), 'not-a-real-handle', 'r')).rejects.toMatchObject(notFound);
  });

  it('row 26: key absent at redemption → 404 (fail closed)', async () => {
    const h = handle();
    delete process.env[INBOX_HANDLE_KEY_ENV];
    const { svc, repo } = inbox();
    await expect(svc.sign(auth(), h, 'r')).rejects.toMatchObject(notFound);
    expect(repo.issueDiscoveredRecipientSession).not.toHaveBeenCalled();
  });

  // Rows 16, 24, 27 — a valid handle whose revalidation fails answers today's reasons.
  it.each<InboxSigningRefusal>(['association_inactive', 'envelope_not_signable', 'signer_ineligible', 'not_your_turn', 'session_revoked', 'link_expired'])(
    'rows 16 / 24 / 27: revalidation refusal %s → 409 with that reason',
    async (reason) => {
      await expect(inbox({ refuse: reason }).svc.sign(auth(), handle(), 'r')).rejects.toMatchObject({ statusCode: 409, code: 'ENVELOPE_ILLEGAL_TRANSITION', context: { details: { reason } } });
    },
  );

  it('a handle on the binding-only routes reads as not found (never reaches the database)', async () => {
    const repo = { getForUser: vi.fn(), revoke: vi.fn() };
    const svc = new RecipientInboxService(repo as never, {} as never);
    await expect(svc.signedCopy(auth(), handle(), 'r')).rejects.toMatchObject(notFound);
    await expect(svc.remove(auth(), handle(), 'r')).rejects.toMatchObject(notFound);
    expect(repo.getForUser).not.toHaveBeenCalled();
    expect(repo.revoke).not.toHaveBeenCalled();
  });
});

// ── Sender list: awaiting_you (§A3.5) ─────────────────────────────────────────
const SENDER_TENANT_ID = '55555555-5555-7555-8555-555555555555';
function senderList(envelopes: unknown[], proof: typeof PROOF | null, bindings: { live?: Record<string, string>; any?: string[] } = {}) {
  const repo = {
    listEnvelopes: vi.fn(async () => envelopes),
    lastEventAt: vi.fn(async () => new Map()),
    countByStatus: vi.fn(async () => ({})),
  };
  const tenants = {
    findById: vi.fn(async () => ({ id: SENDER_TENANT_ID, name: 'Astre', kind: 'BUSINESS', is_active: true, status: 'ACTIVE' })),
    findSlugById: vi.fn(async () => 'astre'),
    findOrganizationNameById: vi.fn(async () => 'Astre'),
  };
  const ctx = new SenderContextService(tenants as never, { findUserById: vi.fn(async () => null), findMembership: vi.fn(async () => null), findRoleKeysForMembership: vi.fn(async () => []) } as never);
  const inboxRepo = {
    verifiedEmailProof: vi.fn(async () => proof),
    liveBindingIds: vi.fn(async (_u: string, ids: readonly string[]) => new Map(ids.filter((i) => bindings.live?.[i] !== undefined).map((i) => [i, bindings.live![i]!]))),
    anyBindingSignerIds: vi.fn(async (_u: string, ids: readonly string[]) => new Set(ids.filter((i) => bindings.live?.[i] !== undefined || bindings.any?.includes(i)))),
  };
  const optional = Array.from({ length: 10 }, () => undefined);
  const svc = new SenderEnvelopeService(repo as never, {} as never, ctx, { findUserById: vi.fn(async () => null) } as never, {} as never, {} as never, {} as never, ...(optional as []), inboxRepo as never);
  return { svc, inboxRepo };
}
const env = (id: string, over: Record<string, unknown>, signers: Array<Record<string, unknown>>) => ({
  id, subject: 'S', status: 'SENT', routing_mode: 'PARALLEL', created_at: new Date(), updated_at: new Date(), sent_at: new Date('2026-10-20T00:00:00.000Z'), completed_at: null, expires_at: null,
  source_application: 'aramo-sign', documents: [], purge_state: null, purge_level: null, purge_due_at: null, purge_executed_at: null, ...over,
  signers: signers.map((s, i) => ({ id: `s${i}`, name: 'n', email: null, status: 'PENDING', recipient_kind: 'SIGNER', signing_order: i + 1, witness_for_signer_id: null, bound_user_id: null, ...s })),
});
const senderAuth: AuthContextType = { sub: USER, consumer_type: 'sign', actor_kind: 'user', tenant_id: SENDER_TENANT_ID, scopes: ['sign:envelope:read'], iat: 0, exp: 0 };

describe('W2 §A3.5 — sender list awaiting_you', () => {
  it('rows 1 / 2 / 5 / 6: true only while my step is the only actionable one', async () => {
    const { svc } = senderList(
      [
        env('row1-typed-own-email', {}, [{ email: ' Dana@Example.TEST ' }]),
        env('row2-assigned', {}, [{ email: 'alias@example.test', bound_user_id: USER }]),
        env('row5-parallel-with-other', {}, [{ email: 'dana@example.test' }, { email: 'other@example.test' }]),
        env('row5-after-i-signed', { status: 'IN_PROGRESS' }, [{ email: 'dana@example.test', status: 'SIGNED' }, { email: 'other@example.test' }]),
        env('sequential-other-first', { routing_mode: 'SEQUENTIAL' }, [{ email: 'other@example.test' }, { email: 'dana@example.test' }]),
        env('sequential-my-turn', { routing_mode: 'SEQUENTIAL', status: 'IN_PROGRESS' }, [{ email: 'other@example.test', status: 'SIGNED' }, { email: 'dana@example.test' }]),
        env('sent-before-proof', { sent_at: new Date('2026-09-01T00:00:00.000Z') }, [{ email: 'dana@example.test' }]),
        env('copy-only-mine', {}, [{ email: 'dana@example.test', recipient_kind: 'RECEIVES_COPY' }, { email: 'other@example.test' }]),
        env('completed', { status: 'COMPLETED' }, [{ email: 'dana@example.test', status: 'SIGNED' }]),
        env('draft', { status: 'DRAFT', sent_at: null }, [{ email: 'dana@example.test' }]),
        env('expired-window', { expires_at: new Date(Date.now() - 1000) }, [{ email: 'dana@example.test' }]),
      ],
      PROOF,
    );
    const out = await svc.list(senderAuth, {}, 'r');
    expect(Object.fromEntries(out.items.map((i) => [i.id, i.awaiting_you]))).toEqual({
      'row1-typed-own-email': true,
      'row2-assigned': true,
      'row5-parallel-with-other': false,
      'row5-after-i-signed': false,
      'sequential-other-first': false,
      'sequential-my-turn': true,
      'sent-before-proof': false,
      'copy-only-mine': false,
      completed: false,
      draft: false,
      'expired-window': false,
    });
  });

  it('without a proof only bound_user_id matches; the proof is not read when nothing is open', async () => {
    const { svc } = senderList([env('typed', {}, [{ email: 'dana@example.test' }]), env('assigned', {}, [{ bound_user_id: USER, email: 'x@example.test' }])], null);
    expect((await svc.list(senderAuth, {}, 'r')).items.map((i) => i.awaiting_you)).toEqual([false, true]);
    const closed = senderList([env('done', { status: 'COMPLETED' }, [{ email: 'dana@example.test', status: 'SIGNED' }])], PROOF);
    await closed.svc.list(senderAuth, {}, 'r');
    expect(closed.inboxRepo.verifiedEmailProof).not.toHaveBeenCalled();
  });
});

describe('W2 (orchestrator addition) — sender list my_inbox_item_id', () => {
  const at = (items: Array<Record<string, unknown>>, id: string) => items.find((i) => i['id'] === id)!;
  const fixtures = () => [
    env('proven', {}, [{ id: 'a4000000-0000-7000-8000-000000000004', email: 'dana@example.test' }]),
    env('bound', {}, [{ id: 'sig-bound', email: 'dana@example.test' }]),
    env('assigned-unproven', {}, [{ id: 'sig-assigned', email: 'alias@example.test', bound_user_id: USER }]),
    env('removed-binding', {}, [{ id: 'sig-removed', email: 'dana@example.test' }]),
    env('not-awaiting', {}, [{ id: 'sig-a', email: 'dana@example.test' }, { id: 'sig-b', email: 'other@example.test' }]),
  ];

  it('binding id when bound; a same-user handle when proven; null otherwise; absent-awaiting → null', async () => {
    const { svc } = senderList(fixtures(), PROOF, { live: { 'sig-bound': BINDING }, any: ['sig-removed'] });
    const items = (await svc.list(senderAuth, {}, 'r')).items as Array<Record<string, unknown>>;
    expect(at(items, 'bound')).toMatchObject({ awaiting_you: true, my_inbox_item_id: BINDING });
    const handle = at(items, 'proven')['my_inbox_item_id'] as string;
    expect(handle).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(openInboxHandle(KEY, handle, USER)?.signer_id).toBe('a4000000-0000-7000-8000-000000000004');
    expect(at(items, 'assigned-unproven')).toMatchObject({ awaiting_you: true, my_inbox_item_id: null });
    expect(at(items, 'removed-binding')).toMatchObject({ awaiting_you: true, my_inbox_item_id: null });
    expect(at(items, 'not-awaiting')).toMatchObject({ awaiting_you: false, my_inbox_item_id: null });
  });

  it('fixed row: the handle redeems only for the same user (another user → 404 inbox_item_not_found, nothing minted)', async () => {
    const real = 'a3000000-0000-7000-8000-000000000003';
    const { svc } = senderList([env('proven', {}, [{ id: real, email: 'dana@example.test' }])], PROOF);
    const handle = ((await svc.list(senderAuth, {}, 'r')).items[0] as Record<string, unknown>)['my_inbox_item_id'] as string;
    expect(openInboxHandle(KEY, handle, OTHER_USER)).toBeNull();
    const mine = inbox();
    await expect(mine.svc.sign(auth(), handle, 'r')).resolves.toMatchObject({ signing_url: expect.any(String) });
    expect(mine.repo.issueDiscoveredRecipientSession).toHaveBeenCalledWith(USER, real);
    const theirs = inbox();
    await expect(theirs.svc.sign(auth(OTHER_USER), handle, 'r')).rejects.toMatchObject({ statusCode: 404, context: { details: { reason: 'inbox_item_not_found' } } });
    expect(theirs.repo.issueDiscoveredRecipientSession).not.toHaveBeenCalled();
  });

  it('fixed row: only the caller’s own steps — never another user’s binding or another tenant’s ids', async () => {
    const { svc, inboxRepo } = senderList(fixtures(), PROOF, { live: { 'sig-bound': BINDING } });
    await svc.list(senderAuth, {}, 'r');
    for (const call of [...inboxRepo.liveBindingIds.mock.calls, ...inboxRepo.anyBindingSignerIds.mock.calls]) expect(call[0]).toBe(USER);
  });

  it('discovery off (no key) → a proven step gets no handle; a bound one keeps its binding id', async () => {
    delete process.env[INBOX_HANDLE_KEY_ENV];
    const { svc } = senderList(fixtures(), PROOF, { live: { 'sig-bound': BINDING } });
    const items = (await svc.list(senderAuth, {}, 'r')).items as Array<Record<string, unknown>>;
    expect(at(items, 'proven')['my_inbox_item_id']).toBeNull();
    expect(at(items, 'bound')['my_inbox_item_id']).toBe(BINDING);
  });
});
