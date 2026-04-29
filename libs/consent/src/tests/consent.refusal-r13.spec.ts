import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository, type RecordGrantEventInput } from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Charter Refusal R13: consent integrity over engagement velocity.
// If any write in the grant transaction fails (audit, outbox, idempotency
// row), the entire request fails with a structured error. No partial
// writes, no "best effort" paths.
//
// Verified by: forcing each downstream write to fail in turn and
// asserting the transaction throws — Prisma's $transaction wrapper rolls
// back the prior writes when the callback throws.

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';

interface MockTx {
  idempotencyKey: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  talentConsentEvent: { create: ReturnType<typeof vi.fn> };
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

function makeInput(): RecordGrantEventInput {
  return {
    tenant_id: TENANT_ID,
    talent_id: TALENT_ID,
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

describe('Refusal R13 — consent integrity over engagement velocity', () => {
  it('propagates audit-write failure (no partial-success swallow)', async () => {
    const tx = makeTx();
    tx.consentAuditEvent.create.mockRejectedValue(new Error('audit DB down'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordGrantEvent(makeInput())).rejects.toThrow('audit DB down');
  });

  it('propagates outbox-write failure (no partial-success swallow)', async () => {
    const tx = makeTx();
    tx.outboxEvent.create.mockRejectedValue(new Error('outbox unavailable'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordGrantEvent(makeInput())).rejects.toThrow('outbox unavailable');
  });

  it('propagates idempotency-key persist failure (no partial-success swallow)', async () => {
    const tx = makeTx();
    tx.idempotencyKey.create.mockRejectedValue(new Error('idempotency conflict at db'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordGrantEvent(makeInput())).rejects.toThrow(
      'idempotency conflict at db',
    );
  });

  it('propagates consent-event-write failure (no fallback path)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.create.mockRejectedValue(new Error('consent insert failed'));
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(repo.recordGrantEvent(makeInput())).rejects.toThrow('consent insert failed');
  });
});
