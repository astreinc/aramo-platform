import { describe, expect, it, vi } from 'vitest';

import {
  ConsentRepository,
  type RecordConsentEventInput,
} from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Charter Refusal R13: consent integrity over engagement velocity.
// If any write in the consent-event transaction fails (audit, outbox,
// idempotency row), the entire request fails with a structured error.
// PR-3 extends the rollback surface to the revoke lookup
// (tx.talentConsentEvent.findFirst for revoked_event_id): a lookup
// failure must abort the transaction before any write happens.

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const PRIOR_GRANT_ID = '00000000-0000-0000-0000-0000000000cc';

interface MockTx {
  idempotencyKey: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  talentConsentEvent: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  consentAuditEvent: { create: ReturnType<typeof vi.fn> };
  outboxEvent: { create: ReturnType<typeof vi.fn> };
}

function makeTx(): MockTx {
  return {
    idempotencyKey: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    talentConsentEvent: {
      create: vi.fn().mockResolvedValue({ created_at: new Date() }),
      findFirst: vi.fn().mockResolvedValue({ id: PRIOR_GRANT_ID }),
      findMany: vi.fn().mockResolvedValue([]),
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

function makeGrantInput(): RecordConsentEventInput {
  return {
    tenant_id: TENANT_ID,
    talent_id: TALENT_ID,
    action: 'granted',
    scope: 'matching',
    captured_method: 'recruiter_capture',
    captured_by_actor_id: null,
    consent_version: 'v1',
    occurred_at: '2026-04-29T00:00:00Z',
    idempotencyKey: 'd2d7a0f0-0000-7000-8000-000000000001',
    requestHash: 'hash-1',
    requestId: 'req-1',
  };
}

function makeRevokeInput(): RecordConsentEventInput {
  return { ...makeGrantInput(), action: 'revoked' };
}

describe('Refusal R13 — consent integrity over engagement velocity', () => {
  it('grant: propagates audit-write failure (no partial-success swallow)', async () => {
    const tx = makeTx();
    tx.consentAuditEvent.create.mockRejectedValue(new Error('audit DB down'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeGrantInput())).rejects.toThrow('audit DB down');
  });

  it('grant: propagates outbox-write failure (no partial-success swallow)', async () => {
    const tx = makeTx();
    tx.outboxEvent.create.mockRejectedValue(new Error('outbox unavailable'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeGrantInput())).rejects.toThrow('outbox unavailable');
  });

  it('grant: propagates idempotency-key persist failure (no partial-success swallow)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.create.mockRejectedValue(new Error('idempotency conflict at db'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeGrantInput())).rejects.toThrow(
      'idempotency conflict at db',
    );
  });

  it('grant: propagates consent-event-write failure (no fallback path)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.create.mockRejectedValue(new Error('consent insert failed'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeGrantInput())).rejects.toThrow('consent insert failed');
  });

  it('revoke: propagates audit-write failure', async () => {
    const tx = makeTx();
    tx.consentAuditEvent.create.mockRejectedValue(new Error('audit DB down'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeRevokeInput())).rejects.toThrow('audit DB down');
  });

  it('revoke: propagates outbox-write failure', async () => {
    const tx = makeTx();
    tx.outboxEvent.create.mockRejectedValue(new Error('outbox unavailable'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeRevokeInput())).rejects.toThrow('outbox unavailable');
  });

  it('revoke: lookup failure aborts the transaction with no writes', async () => {
    // PR-3 extension: if findFirst (the revoked_event_id lookup) fails,
    // the whole transaction must abort BEFORE any write — preserves R13
    // and prevents a half-written revocation lacking referential linkage.
    const tx = makeTx();
    tx.talentConsentEvent.findFirst.mockRejectedValue(new Error('lookup DB down'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordConsentEvent(makeRevokeInput())).rejects.toThrow('lookup DB down');
    expect(tx.talentConsentEvent.create).not.toHaveBeenCalled();
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.idempotencyKey.create).not.toHaveBeenCalled();
  });

  // ===================================================================
  // PR-4 extension: resolver path (resolveConsentState). The resolver
  // computation + decision-log audit write live in the same transaction;
  // failure of either rolls back atomically. R13 holds for the
  // resolver-path category as well.
  // ===================================================================

  it('resolver: ledger findMany failure aborts before any audit write', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockRejectedValue(new Error('ledger read DB down'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(
      repo.resolveConsentState({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        operation: 'matching',
        requestHash: 'r13-h-1',
        requestId: 'r13-req-1',
      }),
    ).rejects.toThrow('ledger read DB down');
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
  });

  it('resolver: decision-log audit write failure rolls back the resolver state', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    tx.consentAuditEvent.create.mockRejectedValue(new Error('audit DB down'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(
      repo.resolveConsentState({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        operation: 'matching',
        requestHash: 'r13-h-2',
        requestId: 'r13-req-2',
      }),
    ).rejects.toThrow('audit DB down');
  });

  it('resolver: idempotency-cache persist failure rolls back the audit write', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    tx.idempotencyKey.create.mockRejectedValue(new Error('idempotency persist failed'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(
      repo.resolveConsentState({
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        operation: 'matching',
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000400',
        requestHash: 'r13-h-3',
        requestId: 'r13-req-3',
      }),
    ).rejects.toThrow('idempotency persist failed');
    // The audit write happened inside the transaction but rolls back atomically.
    // We can verify the call was attempted (tx semantics live in the real DB).
    expect(tx.consentAuditEvent.create).toHaveBeenCalled();
  });
});
