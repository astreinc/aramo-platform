import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository, type RecordGrantEventInput } from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Belt-and-suspenders test: even if a client somehow injects
// `action: "revoked"` (e.g., the OpenAPI schema's
// `additionalProperties: false` rejection were bypassed), the persisted
// row has `action: "granted"`. This is layer 3 of the action-lock
// defense:
//   1. OpenAPI schema (`additionalProperties: false` + no `action` field)
//   2. class-validator pipe (`forbidNonWhitelisted: true`)
//   3. Repository hardcodes `action: 'granted'` on insert (this test)

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';

interface MockTx {
  idempotencyKey: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  talentConsentEvent: { create: ReturnType<typeof vi.fn> };
  consentAuditEvent: { create: ReturnType<typeof vi.fn> };
  outboxEvent: { create: ReturnType<typeof vi.fn> };
}

describe('Refusal — action locked to "granted" on /consent/grant', () => {
  it('writes action="granted" even if input claims action="revoked"', async () => {
    const tx: MockTx = {
      idempotencyKey: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      talentConsentEvent: {
        create: vi.fn().mockResolvedValue({ created_at: new Date() }),
      },
      consentAuditEvent: { create: vi.fn() },
      outboxEvent: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn().mockImplementation(async (fn: (t: MockTx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const repo = new ConsentRepository(prisma);

    // Force a hostile input through the type system to simulate a bypass.
    const input = {
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
      // Hostile field: ignored by the repository.
      action: 'revoked',
    } as unknown as RecordGrantEventInput;

    const result = await repo.recordGrantEvent(input);
    expect(result.action).toBe('granted');
    const writtenRow = tx.talentConsentEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(writtenRow.data.action).toBe('granted');
  });
});
