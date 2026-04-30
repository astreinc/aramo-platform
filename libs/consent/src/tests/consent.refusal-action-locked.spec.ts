import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import {
  ConsentRepository,
  type RecordConsentEventInput,
} from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Belt-and-suspenders test: the action-lock guarantee is enforced at
// four layers, none relying on type safety alone:
//   1. OpenAPI schema (`additionalProperties: false` + no `action` field)
//   2. class-validator pipe (`forbidNonWhitelisted: true`)
//   3. Service layer hardcodes the action literal when calling the repo
//   4. Repository runtime guard rejects unsupported action values
//      (PR-3 refinement; matches the R8/R9 Charter-refusal idiom of
//      multi-layer enforcement)

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';

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
    idempotencyKey: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    talentConsentEvent: {
      create: vi.fn().mockResolvedValue({ created_at: new Date() }),
      findFirst: vi.fn().mockResolvedValue(null),
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

function validRevokeInput(): RecordConsentEventInput {
  return {
    tenant_id: TENANT_ID,
    talent_id: TALENT_ID,
    action: 'revoked',
    scope: 'matching',
    captured_method: 'recruiter_capture',
    captured_by_actor_id: null,
    consent_version: 'v1',
    occurred_at: '2026-04-29T00:00:00Z',
    idempotencyKey: 'd2d7a0f0-0000-7000-8000-000000000099',
    requestHash: 'hash-r1',
    requestId: 'req-r1',
  };
}

describe('Refusal — action locked per endpoint', () => {
  it('grant: writes action="granted" when the input action is "granted" (defense-in-depth)', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const repo = new ConsentRepository(prisma);

    const input = {
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
    } satisfies RecordConsentEventInput;

    const result = await repo.recordConsentEvent(input);
    expect(result.action).toBe('granted');
    const writtenRow = tx.talentConsentEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(writtenRow.data.action).toBe('granted');
  });

  it('revoke: writes action="revoked" when the input action is "revoked" (defense-in-depth)', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const repo = new ConsentRepository(prisma);

    const result = await repo.recordConsentEvent(validRevokeInput());
    expect(result.action).toBe('revoked');
    const writtenRow = tx.talentConsentEvent.create.mock.calls[0][0] as { data: { action: string } };
    expect(writtenRow.data.action).toBe('revoked');
  });

  it('refuses unsupported action values at the repo layer (runtime guard)', async () => {
    // Force an invalid action through the type system. The TS narrowing
    // in recordConsentEvent's signature (T extends 'granted' | 'revoked')
    // would normally reject this at compile time; the `as any` cast
    // bypasses narrowing to simulate an attack vector where:
    //   - JSON deserialization fills the field with an unexpected value, or
    //   - a future caller passes input data through an `as any` cast, or
    //   - a test forces the check.
    // The runtime guard catches at runtime regardless.
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const repo = new ConsentRepository(prisma);

    const hostileInput = {
      ...validRevokeInput(),
      action: 'mutated',
    } as unknown as RecordConsentEventInput;

    await expect(repo.recordConsentEvent(hostileInput)).rejects.toBeInstanceOf(
      AramoError,
    );

    // No writes should have happened — the guard fires before the
    // transaction opens.
    expect(tx.talentConsentEvent.create).not.toHaveBeenCalled();
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
    expect(tx.idempotencyKey.create).not.toHaveBeenCalled();
    expect(tx.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it('runtime guard rejects with INTERNAL_ERROR + 500 + received_action detail', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const repo = new ConsentRepository(prisma);

    const hostileInput = {
      ...validRevokeInput(),
      action: 'expired',  // valid in the §2.2 entity enum but not in PR-3's set
    } as unknown as RecordConsentEventInput;

    await expect(repo.recordConsentEvent(hostileInput)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 500,
      context: { details: { received_action: 'expired' } },
    });
  });
});
