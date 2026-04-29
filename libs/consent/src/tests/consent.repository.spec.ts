import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository, type RecordGrantEventInput } from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';

interface MockTx {
  idempotencyKey: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  talentConsentEvent: { create: ReturnType<typeof vi.fn> };
  consentAuditEvent: { create: ReturnType<typeof vi.fn> };
  outboxEvent: { create: ReturnType<typeof vi.fn> };
}

function makeTx(): MockTx {
  return {
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    talentConsentEvent: {
      create: vi.fn().mockResolvedValue({ created_at: new Date('2026-04-29T01:00:00Z') }),
    },
    consentAuditEvent: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
}

function makePrisma(tx: MockTx): PrismaService {
  return {
    $transaction: vi.fn().mockImplementation(async (fn: (t: MockTx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
}

function makeInput(overrides: Partial<RecordGrantEventInput> = {}): RecordGrantEventInput {
  return {
    tenant_id: TENANT_ID,
    talent_id: TALENT_ID,
    scope: 'matching',
    captured_method: 'recruiter_capture',
    captured_by_actor_id: RECRUITER_ID,
    consent_version: 'v1',
    occurred_at: '2026-04-29T00:00:00Z',
    idempotencyKey: 'd2d7a0f0-0000-7000-8000-000000000001',
    requestHash: 'hash-1',
    requestId: 'req-1',
    ...overrides,
  };
}

describe('ConsentRepository.recordGrantEvent', () => {
  it('writes consent + audit + outbox + idempotency rows in a transaction (happy path)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.recordGrantEvent(makeInput());

    expect(tx.talentConsentEvent.create).toHaveBeenCalledOnce();
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(tx.idempotencyKey.create).toHaveBeenCalledOnce();
    expect(result.action).toBe('granted');
    expect(result.scope).toBe('matching');
    expect(result.tenant_id).toBe(TENANT_ID);
  });

  it('forces action="granted" regardless of any input value (belt-and-suspenders)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    // Intentionally inject an action — the DTO does not have it, but if any
    // future change relaxes the type, the repo's hardcoded value still wins.
    const input = { ...makeInput(), action: 'revoked' as const } as unknown as RecordGrantEventInput;
    const result = await repo.recordGrantEvent(input);
    expect(result.action).toBe('granted');
    const writtenRow = tx.talentConsentEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(writtenRow.data.action).toBe('granted');
  });

  it('replays the original response on idempotent retry (same key, same hash)', async () => {
    const tx = makeTx();
    const original = {
      event_id: 'evt-1',
      tenant_id: TENANT_ID,
      action: 'granted',
      scope: 'matching',
    };
    tx.idempotencyKey.findUnique.mockResolvedValue({
      request_hash: 'hash-1',
      response_body: original,
    });
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.recordGrantEvent(makeInput());
    expect(result).toEqual(original);
    expect(tx.talentConsentEvent.create).not.toHaveBeenCalled();
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('throws IDEMPOTENCY_KEY_CONFLICT on same key with a different request hash', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue({
      request_hash: 'different-hash',
      response_body: {},
    });
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordGrantEvent(makeInput())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    });
  });

  it('marks actor_type=self when captured_method=self_signup', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.recordGrantEvent(
      makeInput({ captured_method: 'self_signup', captured_by_actor_id: null }),
    );
    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { actor_type: string };
    };
    expect(auditRow.data.actor_type).toBe('self');
  });

  it('throws AramoError instances (not generic errors)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue({
      request_hash: 'mismatch',
      response_body: {},
    });
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordGrantEvent(makeInput())).rejects.toBeInstanceOf(AramoError);
  });

  it('exposes no update method on the repository (immutability enforcement layer 1)', () => {
    const tx = makeTx();
    const repo = new ConsentRepository(makePrisma(tx));
    expect((repo as unknown as Record<string, unknown>)['updateGrantEvent']).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>)['updateConsentEvent']).toBeUndefined();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    expect(methods.some((m) => m.toLowerCase().includes('update'))).toBe(false);
  });

  // Defensive deep-equality test: locks the replay-path contract.
  // If a future schema change introduces a non-primitive response field
  // (e.g., a Date that JSON-round-trips to string and back), this test
  // catches the type drift because toStrictEqual checks types, not just
  // values.
  it('replay returns identical response shape and types', async () => {
    const tx = makeTx();
    // First call: no idempotency record yet → write path runs.
    tx.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    const repo = new ConsentRepository(makePrisma(tx));

    const input = makeInput({
      idempotencyKey: 'aabbccdd-0000-7000-8000-000000000099',
      requestHash: 'replay-test-hash',
    });
    const first = await repo.recordGrantEvent(input);

    // Capture the row that the repo persisted, and have findUnique return
    // it on the second call. This simulates the post-first-call DB state.
    const persistedRow = tx.idempotencyKey.create.mock.calls[0][0] as {
      data: { request_hash: string; response_body: unknown };
    };
    tx.idempotencyKey.findUnique.mockResolvedValueOnce({
      request_hash: persistedRow.data.request_hash,
      response_body: persistedRow.data.response_body,
    });

    const replay = await repo.recordGrantEvent(input);

    // toStrictEqual catches type drift across JSON serialization round-trip.
    expect(replay).toStrictEqual(first);
  });
});
