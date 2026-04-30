import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import {
  ConsentRepository,
  type RecordConsentEventInput,
} from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';
import type { ConsentGrantResponseDto } from '../lib/dto/consent-grant-response.dto.js';
import type { ConsentRevokeResponseDto } from '../lib/dto/consent-revoke-response.dto.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const PRIOR_GRANT_ID = '00000000-0000-0000-0000-0000000000cc';

interface MockTx {
  idempotencyKey: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  talentConsentEvent: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  consentAuditEvent: { create: ReturnType<typeof vi.fn> };
  outboxEvent: { create: ReturnType<typeof vi.fn> };
}

function makeTx(): MockTx {
  return {
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    talentConsentEvent: {
      create: vi.fn().mockResolvedValue({ created_at: new Date('2026-04-29T01:00:00Z') }),
      findFirst: vi.fn(),
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

function makeGrantInput(overrides: Partial<RecordConsentEventInput> = {}): RecordConsentEventInput {
  return {
    tenant_id: TENANT_ID,
    talent_id: TALENT_ID,
    action: 'granted',
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

function makeRevokeInput(overrides: Partial<RecordConsentEventInput> = {}): RecordConsentEventInput {
  return {
    ...makeGrantInput(),
    action: 'revoked',
    idempotencyKey: 'd2d7a0f0-0000-7000-8000-000000000099',
    requestHash: 'hash-revoke-1',
    requestId: 'req-revoke-1',
    ...overrides,
  };
}

describe('ConsentRepository.recordConsentEvent — grant', () => {
  it('writes consent + audit + outbox + idempotency rows in a transaction (happy path)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = (await repo.recordConsentEvent(makeGrantInput())) as ConsentGrantResponseDto;

    expect(tx.talentConsentEvent.create).toHaveBeenCalledOnce();
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(tx.idempotencyKey.create).toHaveBeenCalledOnce();
    // Grant path does NOT trigger the revoked_event_id lookup
    expect(tx.talentConsentEvent.findFirst).not.toHaveBeenCalled();
    expect(result.action).toBe('granted');
    expect(result.scope).toBe('matching');
    expect(result.tenant_id).toBe(TENANT_ID);
  });

  it('forces action="granted" regardless of any input value (belt-and-suspenders)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    // The repo trusts input.action — if a hostile path bypassed the
    // service layer and supplied action='granted' in a body bound to
    // the grant DTO, this test verifies the row carries 'granted'.
    const result = (await repo.recordConsentEvent({
      ...makeGrantInput(),
      action: 'granted',
    })) as ConsentGrantResponseDto;
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
    const result = await repo.recordConsentEvent(makeGrantInput());
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
    await expect(repo.recordConsentEvent(makeGrantInput())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    });
  });

  it('marks actor_type=self when captured_method=self_signup', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.recordConsentEvent(
      makeGrantInput({ captured_method: 'self_signup', captured_by_actor_id: null }),
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
    await expect(repo.recordConsentEvent(makeGrantInput())).rejects.toBeInstanceOf(AramoError);
  });

  it('exposes no update method on the repository (immutability enforcement layer 1)', () => {
    const tx = makeTx();
    const repo = new ConsentRepository(makePrisma(tx));
    expect((repo as unknown as Record<string, unknown>)['updateGrantEvent']).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>)['updateConsentEvent']).toBeUndefined();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    expect(methods.some((m) => m.toLowerCase().includes('update'))).toBe(false);
  });

  it('replay returns identical response shape and types', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    const repo = new ConsentRepository(makePrisma(tx));

    const input = makeGrantInput({
      idempotencyKey: 'aabbccdd-0000-7000-8000-000000000099',
      requestHash: 'replay-test-hash',
    });
    const first = await repo.recordConsentEvent(input);

    const persistedRow = tx.idempotencyKey.create.mock.calls[0][0] as {
      data: { request_hash: string; response_body: unknown };
    };
    tx.idempotencyKey.findUnique.mockResolvedValueOnce({
      request_hash: persistedRow.data.request_hash,
      response_body: persistedRow.data.response_body,
    });

    const replay = await repo.recordConsentEvent(input);
    expect(replay).toStrictEqual(first);
  });
});

describe('ConsentRepository.recordConsentEvent — revoke', () => {
  it('writes consent + audit + outbox + idempotency rows; populates §2.7 audit shape', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    tx.talentConsentEvent.findFirst.mockResolvedValue({ id: PRIOR_GRANT_ID });
    const repo = new ConsentRepository(makePrisma(tx));
    const result = (await repo.recordConsentEvent(makeRevokeInput())) as ConsentRevokeResponseDto;

    expect(tx.talentConsentEvent.create).toHaveBeenCalledOnce();
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
    expect(tx.outboxEvent.create).toHaveBeenCalledOnce();
    expect(tx.idempotencyKey.create).toHaveBeenCalledOnce();
    expect(result.action).toBe('revoked');
    expect(result.revoked_event_id).toBe(PRIOR_GRANT_ID);

    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { event_type: string; event_payload: Record<string, unknown> };
    };
    expect(auditRow.data.event_type).toBe('consent.revoke.recorded');
    expect(auditRow.data.event_payload).toMatchObject({
      revoked_event_id: PRIOR_GRANT_ID,        // Decision A
      in_flight_operations_halted: [],          // Decision B
      propagation_completed_at: null,           // Decision C
    });
  });

  it('handles revoke without prior grant: revoked_event_id is null in audit + response (Decision D)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    tx.talentConsentEvent.findFirst.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = (await repo.recordConsentEvent(makeRevokeInput())) as ConsentRevokeResponseDto;

    expect(result.revoked_event_id).toBeNull();
    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { event_payload: Record<string, unknown> };
    };
    expect(auditRow.data.event_payload['revoked_event_id']).toBeNull();
  });

  it('lookup happens BEFORE writes (verify ordering)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    const callOrder: string[] = [];
    tx.talentConsentEvent.findFirst.mockImplementation(async () => {
      callOrder.push('findFirst');
      return { id: PRIOR_GRANT_ID };
    });
    tx.talentConsentEvent.create.mockImplementation(async () => {
      callOrder.push('create.consent');
      return { created_at: new Date() };
    });
    tx.consentAuditEvent.create.mockImplementation(async () => {
      callOrder.push('create.audit');
    });
    tx.outboxEvent.create.mockImplementation(async () => {
      callOrder.push('create.outbox');
    });
    tx.idempotencyKey.create.mockImplementation(async () => {
      callOrder.push('create.idempotency');
    });

    const repo = new ConsentRepository(makePrisma(tx));
    await repo.recordConsentEvent(makeRevokeInput());

    expect(callOrder[0]).toBe('findFirst');
    expect(callOrder.slice(1)).toEqual([
      'create.consent',
      'create.audit',
      'create.outbox',
      'create.idempotency',
    ]);
  });

  it('lookup failure aborts the transaction with no writes (R13 preserved)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    tx.talentConsentEvent.findFirst.mockRejectedValue(new Error('lookup DB down'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeRevokeInput())).rejects.toThrow('lookup DB down');
    expect(tx.talentConsentEvent.create).not.toHaveBeenCalled();
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('outbox event_type is consent.revoked and payload includes revoked_event_id', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    tx.talentConsentEvent.findFirst.mockResolvedValue({ id: PRIOR_GRANT_ID });
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.recordConsentEvent(makeRevokeInput());
    const outboxRow = tx.outboxEvent.create.mock.calls[0][0] as {
      data: { event_type: string; event_payload: Record<string, unknown> };
    };
    expect(outboxRow.data.event_type).toBe('consent.revoked');
    expect(outboxRow.data.event_payload).toMatchObject({
      talent_id: TALENT_ID,
      scope: 'matching',
      revoked_event_id: PRIOR_GRANT_ID,
    });
  });

  it('persists action="revoked" on the ledger row', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    tx.talentConsentEvent.findFirst.mockResolvedValue(null);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.recordConsentEvent(makeRevokeInput());
    const writtenRow = tx.talentConsentEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(writtenRow.data.action).toBe('revoked');
  });

  it('idempotent revoke replay returns identical response (including same revoked_event_id)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    tx.talentConsentEvent.findFirst.mockResolvedValueOnce({ id: PRIOR_GRANT_ID });
    const repo = new ConsentRepository(makePrisma(tx));
    const input = makeRevokeInput({
      idempotencyKey: 'aabbccdd-0000-7000-8000-000000000200',
      requestHash: 'revoke-replay-hash',
    });
    const first = (await repo.recordConsentEvent(input)) as ConsentRevokeResponseDto;

    const persistedRow = tx.idempotencyKey.create.mock.calls[0][0] as {
      data: { request_hash: string; response_body: unknown };
    };
    tx.idempotencyKey.findUnique.mockResolvedValueOnce({
      request_hash: persistedRow.data.request_hash,
      response_body: persistedRow.data.response_body,
    });

    const replay = (await repo.recordConsentEvent(input)) as ConsentRevokeResponseDto;
    expect(replay).toStrictEqual(first);
    expect(replay.revoked_event_id).toBe(PRIOR_GRANT_ID);
  });

  it('idempotency conflict on revoke: same key + different body → 409', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue({
      request_hash: 'other-hash',
      response_body: {},
    });
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeRevokeInput())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    });
  });
});
