import 'reflect-metadata';
import * as rules from '@aramo/sign-client';
import { EsignSenderRepository, EsignService, RecipientInboxRepository, SignPurgeRepository } from '@aramo/sign';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { inboxSignable } from '../app/inbox/inbox-actions.js';
import { canRemindRecipient, hostableRecipient, senderActions, type ActionEnvelope, type SenderActionFacts } from '../app/sender/envelope-actions.js';
import { canSelfSignNow } from '../app/sender/sender-envelope.service.js';

// Client Rule Consolidation C3 — PO ruling 2026-11-21 on C1 divergence D-1: every check C1
// tagged `locked` is ONE @aramo/sign-client function, called by the repository / signing engine
// with the row it read under the envelope row lock AND by the C1 `actions` predicate with the
// row it loaded (vi.mock is hoisted above the imports). Each case below spies the shared function and drives BOTH call sites with the
// same row: the spy must see the call from each, and the two must agree.

vi.mock('@aramo/sign-client', async (orig) => {
  const real = await orig<typeof import('@aramo/sign-client')>();
  const spy = <F extends (...a: never[]) => unknown>(f: F) => vi.fn(f);
  return {
    ...real,
    isDraftEditable: spy(real.isDraftEditable),
    isPartyDeletable: spy(real.isPartyDeletable),
    isPurgeEligible: spy(real.isPurgeEligible),
    isPurgeExecuted: spy(real.isPurgeExecuted),
    isPurgeQueued: spy(real.isPurgeQueued),
    remindableSigners: spy(real.remindableSigners),
    sessionIssueRefusal: spy(real.sessionIssueRefusal),
    hostedSessionRefusal: spy(real.hostedSessionRefusal),
    selfSignTarget: spy(real.selfSignTarget),
    envelopeOpenForSigning: spy(real.envelopeOpenForSigning),
    signerMayStillSign: spy(real.signerMayStillSign),
  };
});


const OWNER = { sub: 'u-owner', scopes: ['sign:envelope:read', 'sign:envelope:create', 'sign:envelope:send', 'sign:envelope:manage:all'] };
const FACTS: SenderActionFacts = { can_author: true, purge_enabled: true, in_person_available: true, deleted: false, can_self_sign_now: false, inbox_item: false };

function envOf(over: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    status: 'SENT',
    owner_id: 'u-owner',
    source_application: 'aramo-sign',
    envelope_mode: 'STANDARD',
    routing_mode: 'PARALLEL',
    expires_at: null,
    purge_state: null,
    recipients: [{ id: 's1', status: 'PENDING', signing_order: 1, recipient_kind: 'SIGNER', witness_for_signer_id: null }],
    ...over,
  };
}

const mocked = <K extends keyof typeof rules>(k: K) => rules[k] as unknown as ReturnType<typeof vi.fn>;
const calledWith = (k: keyof typeof rules, pred: (args: unknown[]) => boolean) => mocked(k).mock.calls.some((c) => pred(c as unknown[]));

beforeEach(() => vi.clearAllMocks());

// A Prisma stand-in: $transaction runs the callback with `tx`.
function prismaWith(tx: Record<string, unknown>) {
  return { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never;
}

describe('isDraftEditable — SenderWorkspaceRepository.assertDraft (in lock) and actions.edit', () => {
  it.each([['DRAFT', true], ['SENT', false], ['COMPLETED', false]] as const)('%s → %s', async (status, ok) => {
    const repo = new EsignSenderRepository(prismaWith({ $queryRaw: async () => [{ status, revision: 1 }], signatureEnvelope: { update: async () => ({ revision: 2 }) } }), { revisionIn: async () => 2 } as never);
    const write = repo.updateDraft({ tenant_id: 't', envelope_id: 'e', subject: 'x' });
    if (ok) await expect(write).resolves.toBeDefined();
    else await expect(write).rejects.toMatchObject({ name: expect.stringMatching(/IllegalTransition/) });
    expect(calledWith('isDraftEditable', (a) => a[0] === status)).toBe(true);
    vi.clearAllMocks();
    expect(senderActions(OWNER, envOf({ status }), FACTS).edit).toBe(ok);
    expect(calledWith('isDraftEditable', (a) => a[0] === status)).toBe(true);
  });
});

describe('purge-repository state rules — SignPurgeRepository (in lock) and the delete / restore / purge / dequeue actions', () => {
  const purgeRepo = (row: Record<string, unknown> | null) =>
    new SignPurgeRepository(
      prismaWith({
        signatureEnvelope: { findFirst: async () => row, update: async () => ({}) },
        signEnvelopePartyDeletion: { findUnique: async () => null, create: async () => ({}), update: async () => ({}) },
        signPurgeEvent: { create: async () => ({}) },
      }),
      { lockEnvelope: async () => row?.['status'], appendEvent: async () => ({}) } as never,
      { enqueue: async () => undefined } as never,
    );
  const row = (status: string, purge_state: string | null = null) => ({ id: 'e', tenant_id: 't', status, deleted_at: null, purge_state, purge_level: 'DOCUMENTS', purge_reason: 'targeted', purge_due_at: null });

  it.each([['COMPLETED', true], ['EXPIRED', true], ['SENT', false], ['DRAFT', false]] as const)('isPartyDeletable %s → %s', async (status, ok) => {
    const out = await purgeRepo(row(status)).partyDelete('t', 'e', { kind: 'SENDER', key: 't' }, 'u').catch(() => 'deleted');
    expect(out === 'not_eligible').toBe(!ok);
    expect(calledWith('isPartyDeletable', (a) => a[0] === status)).toBe(true);
    vi.clearAllMocks();
    expect(senderActions(OWNER, envOf({ status }), FACTS).delete).toBe(ok);
    expect(calledWith('isPartyDeletable', (a) => a[0] === status)).toBe(true);
  });

  it.each([['COMPLETED', true], ['VOIDED', true], ['EXPIRED', false], ['SENT', false]] as const)('isPurgeEligible %s → %s', async (status, ok) => {
    const out = await purgeRepo(row(status)).queue('t', 'e', { level: 'DOCUMENTS', reason: 'targeted' }).catch(() => 'queued');
    expect(out === 'not_eligible').toBe(!ok);
    expect(calledWith('isPurgeEligible', (a) => a[0] === status)).toBe(true);
    vi.clearAllMocks();
    expect(senderActions(OWNER, envOf({ status }), FACTS).purge).toBe(ok);
    expect(calledWith('isPurgeEligible', (a) => a[0] === status)).toBe(true);
  });

  it.each([['EXECUTED', true], ['QUEUED', false], [null, false]] as const)('isPurgeExecuted %s → %s', async (purge_state, executed) => {
    const out = await purgeRepo(row('COMPLETED', purge_state)).partyRestore('t', 'e', { kind: 'SENDER', key: 't' }, 'u');
    expect(out === 'purged').toBe(executed);
    expect(calledWith('isPurgeExecuted', (a) => a[0] === purge_state)).toBe(true);
    vi.clearAllMocks();
    expect(senderActions(OWNER, envOf({ status: 'COMPLETED', purge_state }), { ...FACTS, deleted: true }).restore).toBe(!executed);
    expect(calledWith('isPurgeExecuted', (a) => a[0] === purge_state)).toBe(true);
  });

  it.each([['QUEUED', true], ['DEQUEUED', false], [null, false]] as const)('isPurgeQueued %s → %s', async (purge_state, queued) => {
    const out = await purgeRepo(row('COMPLETED', purge_state)).dequeue('t', 'e', 'u').catch(() => 'dequeued');
    expect(out === 'not_queued').toBe(!queued);
    expect(calledWith('isPurgeQueued', (a) => a[0] === purge_state)).toBe(true);
    vi.clearAllMocks();
    expect(senderActions(OWNER, envOf({ status: 'COMPLETED', purge_state }), FACTS).dequeue_purge).toBe(queued);
    expect(calledWith('isPurgeQueued', (a) => a[0] === purge_state)).toBe(true);
  });
});

// The signing engine with only the parts these paths read (prisma + repo).
function engine(tx: Record<string, unknown>, status: string): EsignService {
  const svc = Object.create(EsignService.prototype) as EsignService;
  Object.assign(svc, { prisma: prismaWith(tx), repo: { lockEnvelope: async () => status, appendEvent: async () => ({}) } });
  return svc;
}

describe('remindableSigners — EsignService.remindSigner (in lock) and actions.remind / can_remind', () => {
  const signers = [
    { id: 's1', status: 'SIGNED', signing_order: 1, recipient_kind: 'SIGNER', witness_for_signer_id: null },
    { id: 's2', status: 'PENDING', signing_order: 2, recipient_kind: 'SIGNER', witness_for_signer_id: null },
    { id: 's3', status: 'PENDING', signing_order: 3, recipient_kind: 'IN_PERSON_SIGNER', witness_for_signer_id: null },
  ];
  it.each([['PARALLEL', 's2', true], ['SEQUENTIAL', 's2', true], ['PARALLEL', 's3', false]] as const)('%s, %s → %s', async (routing_mode, target, ok) => {
    const tx = {
      signer: { findMany: async () => signers },
      signatureEnvelope: { findFirstOrThrow: async () => ({ routing_mode }) },
      signingSession: { updateMany: async () => ({}), create: async () => ({}) },
    };
    const run = engine(tx, 'SENT').remindSigner('t', 'e', 'u', target);
    if (ok) await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toMatchObject({ name: expect.stringMatching(/Reminder/) });
    expect(calledWith('remindableSigners', (a) => (a[0] as { routing_mode: string }).routing_mode === routing_mode)).toBe(true);
    vi.clearAllMocks();
    const env = envOf({ routing_mode, recipients: signers });
    expect(canRemindRecipient(env, signers.find((s) => s.id === target)!)).toBe(ok);
    expect(calledWith('remindableSigners', (a) => (a[0] as { routing_mode: string }).routing_mode === routing_mode)).toBe(true);
  });
});

describe('hostedSessionRefusal / sessionIssueRefusal — EsignService.issueHostedSession (in lock) and hostable / actions.host_in_person', () => {
  const rows = [
    { id: 'p1', email: null, status: 'PENDING', signing_order: 1, recipient_kind: 'IN_PERSON_SIGNER', witness_for_signer_id: null },
    { id: 's2', email: 'a@x.test', status: 'PENDING', signing_order: 2, recipient_kind: 'SIGNER', witness_for_signer_id: null },
  ];
  it.each([['SENT', 'p1', null], ['SENT', 's2', 'not_in_person_signer'], ['COMPLETED', 'p1', 'envelope_not_signable']] as const)('%s, %s → %s', async (status, id, refusal) => {
    const tx = {
      signatureEnvelope: { findFirst: async () => ({ routing_mode: 'PARALLEL', expires_at: null }) },
      signer: { findMany: async () => rows },
      signingSession: { updateMany: async () => ({}), create: async () => ({}) },
    };
    const run = engine(tx, status).issueHostedSession('t', 'e', id, 'u');
    if (refusal === null) await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toMatchObject({ reason: refusal });
    expect(calledWith('hostedSessionRefusal', (a) => a[2] === id)).toBe(true);
    vi.clearAllMocks();
    expect(hostableRecipient(envOf({ status, recipients: rows }), rows.find((r) => r.id === id)!)).toBe(refusal === null);
    expect(calledWith('hostedSessionRefusal', (a) => a[2] === id)).toBe(true);
  });
});

describe('selfSignTarget + sessionIssueRefusal — EsignService.issueSelfSignSession (in lock) and can_self_sign_now (actions.sign)', () => {
  const rows = (bound: string | null, status = 'PENDING') => [
    { id: 's1', email: 'me@x.test', status, signing_order: 1, recipient_kind: 'SIGNER', witness_for_signer_id: null, bound_user_id: bound },
  ];
  it.each([['u-owner', 'PENDING', null], [null, 'PENDING', 'not_bound_to_you'], ['u-owner', 'SIGNED', 'signer_ineligible']] as const)('bound %s, %s → %s', async (bound, status, refusal) => {
    const tx = {
      signatureEnvelope: { findFirst: async () => ({ routing_mode: 'PARALLEL', expires_at: null }) },
      signer: { findMany: async () => rows(bound, status) },
      signingSession: { create: async () => ({}) },
    };
    const run = engine(tx, 'SENT').issueSelfSignSession('t', 'e', 'u-owner', 'me@x.test');
    if (refusal === null) await expect(run).resolves.toBeDefined();
    else await expect(run).rejects.toMatchObject({ reason: refusal });
    expect(calledWith('selfSignTarget', (a) => a[1] === 'u-owner')).toBe(true);
    if (bound !== null) expect(calledWith('sessionIssueRefusal', (a) => a[2] === 's1')).toBe(true);
    vi.clearAllMocks();
    const can = canSelfSignNow(OWNER, { status: 'SENT', routing_mode: 'PARALLEL', created_by: 'u-owner', source_application: 'aramo-sign', signers: rows(bound, status) });
    expect(can).toBe(refusal === null);
    expect(calledWith('selfSignTarget', (a) => a[1] === 'u-owner')).toBe(true);
    if (bound !== null) expect(calledWith('sessionIssueRefusal', (a) => a[2] === 's1')).toBe(true);
  });
});

describe('envelopeOpenForSigning + signerMayStillSign — RecipientInboxRepository revalidation (in lock) and inbox actions.sign', () => {
  const past = new Date('2020-01-01T00:00:00Z');
  it.each([
    ['SENT', null, 'PENDING', null],
    ['COMPLETED', null, 'PENDING', 'envelope_not_signable'],
    ['SENT', past, 'PENDING', 'envelope_not_signable'],
    ['SENT', null, 'SIGNED', 'signer_ineligible'],
  ] as const)('%s, expires %s, signer %s → %s', async (status, expires_at, signer_status, refusal) => {
    const signer = { id: 's1', email: 'me@x.test', status: signer_status, recipient_kind: 'SIGNER', witness_for_signer_id: null, signing_order: 1 };
    const tx = {
      signRecipientBinding: { findFirst: async () => ({ id: 'b1', user_id: 'u', revoked_at: null, envelope_tenant_id: 't', envelope_id: 'e', signer_id: 's1', email: 'me@x.test', claim_session_id: null }) },
      signatureEnvelope: { findFirst: async () => ({ routing_mode: 'PARALLEL', expires_at, sent_at: new Date(), deleted_at: null }) },
      signer: { findFirst: async () => signer, findMany: async () => [signer] },
      signingSession: { findMany: async () => [] },
    };
    const repo = Object.create(RecipientInboxRepository.prototype) as RecipientInboxRepository;
    Object.assign(repo, { prisma: prismaWith(tx), esign: { lockEnvelope: async () => status, appendEvent: async () => ({}) } });
    // With no live emailed link the open, eligible case ends at session_revoked (after both rules ran).
    await expect(repo.issueRevalidatedRecipientSession('u', 'b1')).rejects.toMatchObject({ reason: refusal ?? 'session_revoked' });
    expect(calledWith('envelopeOpenForSigning', (a) => (a[0] as { status: string }).status === status)).toBe(true);
    vi.clearAllMocks();
    const ok = inboxSignable({ source: 'bound', envelope_status: status, signer_status, envelope_expires_at: expires_at, turn: 'now', link_live: true });
    expect(ok).toBe(refusal === null);
    expect(calledWith('envelopeOpenForSigning', (a) => (a[0] as { status: string }).status === status)).toBe(true);
    if (refusal !== 'envelope_not_signable') expect(calledWith('signerMayStillSign', (a) => a[0] === signer_status)).toBe(true);
  });
});
