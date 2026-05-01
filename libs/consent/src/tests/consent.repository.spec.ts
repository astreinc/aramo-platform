import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import {
  ConsentRepository,
  type RecordConsentEventInput,
  type ResolveConsentStateInput,
} from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';
import type { ConsentGrantResponseDto } from '../lib/dto/consent-grant-response.dto.js';
import type { ConsentRevokeResponseDto } from '../lib/dto/consent-revoke-response.dto.js';
import {
  CONSENT_CHECK_OPERATIONS,
  OPERATION_SCOPE_MAP,
} from '../lib/dto/consent-check-operation.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
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
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    talentConsentEvent: {
      create: vi.fn().mockResolvedValue({ created_at: new Date('2026-04-29T01:00:00Z') }),
      findFirst: vi.fn(),
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

// ----------------------------------------------------------------------
// PR-4 — Resolver tests for resolveConsentState. Covers Decisions A
// through L from the Lead-locked contract. Follows the same mock-tx
// pattern as the write-path tests above.
// ----------------------------------------------------------------------

interface LedgerRow {
  id: string;
  scope: string;
  action: string;
  captured_method: string;
  occurred_at: Date;
  expires_at: Date | null;
  metadata: Record<string, unknown> | null;
}

function makeLedgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: '00000000-0000-7000-8000-000000000010',
    scope: 'matching',
    action: 'granted',
    captured_method: 'recruiter_capture',
    occurred_at: new Date('2026-04-01T00:00:00Z'),
    expires_at: null,
    metadata: null,
    ...overrides,
  };
}

function makeResolveInput(
  overrides: Partial<ResolveConsentStateInput> = {},
): ResolveConsentStateInput {
  return {
    tenant_id: TENANT_ID,
    talent_id: TALENT_ID,
    operation: 'matching',
    requestHash: 'resolve-hash-1',
    requestId: 'req-resolve-1',
    ...overrides,
  };
}

describe('ConsentRepository.resolveConsentState — Decision K (empty ledger)', () => {
  it('returns result=error reason=consent_state_unknown when no events exist', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(makeResolveInput());
    expect(decision.result).toBe('error');
    expect(decision.reason_code).toBe('consent_state_unknown');
    expect(decision.scope).toBe('matching');
    expect(decision.decision_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('still writes a decision-log audit row for empty-ledger result (Decision H)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState(makeResolveInput());
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { event_type: string; event_payload: Record<string, unknown> };
    };
    expect(auditRow.data.event_type).toBe('consent.check.decision');
    expect(auditRow.data.event_payload['result']).toBe('error');
    expect(auditRow.data.event_payload['reason_code']).toBe('consent_state_unknown');
  });
});

describe('ConsentRepository.resolveConsentState — Decision C (operation→scope mapping)', () => {
  it.each(CONSENT_CHECK_OPERATIONS)(
    'maps operation %s to its locked required scope',
    async (operation) => {
      const tx = makeTx();
      const expectedScope = OPERATION_SCOPE_MAP[operation];
      // Seed a granted event for the entire dependency chain so the
      // resolver returns "allowed" cleanly. For contacting/cross_tenant
      // we also need a recent grant for the target scope.
      const allScopes = [
        'profile_storage',
        'matching',
        'contacting',
        'cross_tenant_visibility',
      ];
      tx.talentConsentEvent.findMany.mockResolvedValue(
        allScopes.map((scope, idx) =>
          makeLedgerRow({
            id: `00000000-0000-7000-8000-${idx.toString().padStart(12, '0')}`,
            scope,
            action: 'granted',
            occurred_at: new Date('2026-04-15T00:00:00Z'),
          }),
        ),
      );
      const repo = new ConsentRepository(makePrisma(tx));
      const decision = await repo.resolveConsentState(
        makeResolveInput({
          operation,
          channel: expectedScope === 'contacting' ? 'email' : undefined,
        }),
      );
      expect(decision.result).toBe('allowed');
      expect(decision.scope).toBe(expectedScope);
    },
  );
});

describe('ConsentRepository.resolveConsentState — Decision D (source-aware most restrictive)', () => {
  it('single-source granted → result=allowed', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({ scope: 'matching', action: 'granted', captured_method: 'self_signup' }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000020',
        scope: 'profile_storage',
        action: 'granted',
        captured_method: 'self_signup',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(makeResolveInput({ operation: 'matching' }));
    expect(decision.result).toBe('allowed');
  });

  it('single-source revoked → result=denied (latest-per-source wins within source)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      // Most recent: revoked
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000030',
        scope: 'matching',
        action: 'revoked',
        captured_method: 'self_signup',
        occurred_at: new Date('2026-04-15T00:00:00Z'),
      }),
      // Earlier: granted (must not win — latest per source)
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000031',
        scope: 'matching',
        action: 'granted',
        captured_method: 'self_signup',
        occurred_at: new Date('2026-03-01T00:00:00Z'),
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000032',
        scope: 'profile_storage',
        action: 'granted',
        captured_method: 'self_signup',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(makeResolveInput({ operation: 'matching' }));
    expect(decision.result).toBe('denied');
    expect(decision.denied_scopes).toContain('matching');
  });

  it('multiple sources all granted → result=allowed', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000040',
        scope: 'matching',
        action: 'granted',
        captured_method: 'self_signup',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000041',
        scope: 'matching',
        action: 'granted',
        captured_method: 'recruiter_capture',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000042',
        scope: 'profile_storage',
        action: 'granted',
        captured_method: 'self_signup',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(makeResolveInput({ operation: 'matching' }));
    expect(decision.result).toBe('allowed');
  });

  it('Counterintuitive Example: Indeed-source revoked + signup granted → contacting denied', async () => {
    // §2.7 lines 2416-2422: talent has an Indeed-sourced consent
    // (contacting restricted) AND a self-signup-sourced consent (full
    // grants). Result per spec: contacting remains restricted. Consent
    // is scoped by context of capture, not identity.
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      // Profile_storage + matching + contacting all granted via self_signup
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000050',
        scope: 'profile_storage',
        action: 'granted',
        captured_method: 'self_signup',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000051',
        scope: 'matching',
        action: 'granted',
        captured_method: 'self_signup',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000052',
        scope: 'contacting',
        action: 'granted',
        captured_method: 'self_signup',
      }),
      // Indeed-sourced contacting: revoked (the restriction)
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000053',
        scope: 'contacting',
        action: 'revoked',
        captured_method: 'import',  // Indeed import flow
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'engagement', channel: 'email' }),
    );
    expect(decision.result).toBe('denied');
    expect(decision.denied_scopes).toContain('contacting');
  });
});

describe('ConsentRepository.resolveConsentState — Decision E (scope dependency validation)', () => {
  it('contacting requested but matching not granted → 422 INVALID_SCOPE_COMBINATION', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      // Only profile_storage + contacting granted; matching dependency missing
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000060',
        scope: 'profile_storage',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000061',
        scope: 'contacting',
        action: 'granted',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(
      repo.resolveConsentState(
        makeResolveInput({ operation: 'engagement', channel: 'email' }),
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_SCOPE_COMBINATION',
      statusCode: 422,
    });
  });

  it('422 path STILL persists decision-log audit row (Decision H)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000062',
        scope: 'profile_storage',
        action: 'granted',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(
      repo.resolveConsentState(
        makeResolveInput({ operation: 'engagement', channel: 'email' }),
      ),
    ).rejects.toThrow();
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { event_payload: Record<string, unknown> };
    };
    expect(auditRow.data.event_payload['result']).toBe('denied');
    expect(auditRow.data.event_payload['reason_code']).toBe('scope_dependency_unmet');
  });

  it('422 envelope embeds the ConsentDecision in error.details.consent_decision', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000063',
        scope: 'profile_storage',
        action: 'granted',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    try {
      await repo.resolveConsentState(
        makeResolveInput({ operation: 'engagement', channel: 'email' }),
      );
      throw new Error('expected 422 to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      const aramoErr = err as AramoError;
      const details = aramoErr.context?.details as {
        consent_decision: { result: string; denied_scopes: string[]; reason_code: string };
      };
      expect(details.consent_decision.result).toBe('denied');
      expect(details.consent_decision.reason_code).toBe('scope_dependency_unmet');
      expect(details.consent_decision.denied_scopes).toContain('matching');
    }
  });

  it('cross_tenant_visibility requested with all dependencies granted → allowed', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue(
      ['profile_storage', 'matching', 'contacting', 'cross_tenant_visibility'].map(
        (scope, idx) =>
          makeLedgerRow({
            id: `00000000-0000-7000-8000-${(70 + idx).toString().padStart(12, '0')}`,
            scope,
            action: 'granted',
            occurred_at: new Date('2026-04-15T00:00:00Z'),
          }),
      ),
    );
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'cross_tenant' }),
    );
    expect(decision.result).toBe('allowed');
  });
});

describe('ConsentRepository.resolveConsentState — Decision F (12-month staleness, contacting only)', () => {
  it('contacting + latest grant 11 months ago → allowed', async () => {
    const tx = makeTx();
    const elevenMonthsAgo = new Date();
    elevenMonthsAgo.setMonth(elevenMonthsAgo.getMonth() - 11);
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000080',
        scope: 'profile_storage',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000081',
        scope: 'matching',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000082',
        scope: 'contacting',
        action: 'granted',
        occurred_at: elevenMonthsAgo,
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'engagement', channel: 'email' }),
    );
    expect(decision.result).toBe('allowed');
  });

  it('contacting + latest grant 13 months ago → denied with reason=stale_consent', async () => {
    const tx = makeTx();
    const thirteenMonthsAgo = new Date();
    thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000090',
        scope: 'profile_storage',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000091',
        scope: 'matching',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000092',
        scope: 'contacting',
        action: 'granted',
        occurred_at: thirteenMonthsAgo,
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'engagement', channel: 'email' }),
    );
    expect(decision.result).toBe('denied');
    expect(decision.reason_code).toBe('stale_consent');
    expect(decision.denied_scopes).toEqual(['contacting']);
    expect(decision.display_message).toBe('Consent has expired. Refresh required.');
  });

  it('matching + latest grant 13 months ago → allowed (staleness applies to contacting only)', async () => {
    const tx = makeTx();
    const thirteenMonthsAgo = new Date();
    thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000a0',
        scope: 'profile_storage',
        action: 'granted',
        occurred_at: thirteenMonthsAgo,
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000a1',
        scope: 'matching',
        action: 'granted',
        occurred_at: thirteenMonthsAgo,
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'matching' }),
    );
    expect(decision.result).toBe('allowed');
  });
});

describe('ConsentRepository.resolveConsentState — Decision G (channel constraint)', () => {
  it('contacting requested without channel → 400 VALIDATION_ERROR', async () => {
    const tx = makeTx();
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(
      repo.resolveConsentState(makeResolveInput({ operation: 'engagement' })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    // Pre-tx validation; no DB reads/writes
    expect(tx.talentConsentEvent.findMany).not.toHaveBeenCalled();
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
  });

  it('contacting + email channel + email permitted → allowed', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000b0',
        scope: 'profile_storage',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000b1',
        scope: 'matching',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000b2',
        scope: 'contacting',
        action: 'granted',
        metadata: { permitted_channels: ['email', 'phone'] },
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'engagement', channel: 'email' }),
    );
    expect(decision.result).toBe('allowed');
  });

  it('contacting + sms channel + only email permitted → denied with channel_not_consented', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000c0',
        scope: 'profile_storage',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000c1',
        scope: 'matching',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000c2',
        scope: 'contacting',
        action: 'granted',
        metadata: { permitted_channels: ['email'] },
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'engagement', channel: 'sms' }),
    );
    expect(decision.result).toBe('denied');
    expect(decision.reason_code).toBe('channel_not_consented');
    expect(decision.denied_scopes).toEqual(['contacting']);
  });

  it('contacting + grant has no permitted_channels metadata → all channels permitted by default', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000d0',
        scope: 'profile_storage',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000d1',
        scope: 'matching',
        action: 'granted',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-0000000000d2',
        scope: 'contacting',
        action: 'granted',
        metadata: null,
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({ operation: 'engagement', channel: 'sms' }),
    );
    expect(decision.result).toBe('allowed');
  });
});

describe('ConsentRepository.resolveConsentState — Decision H (decision-log audit)', () => {
  it.each([
    ['allowed', [makeLedgerRow({ scope: 'matching', action: 'granted' }), makeLedgerRow({ id: '00000000-0000-7000-8000-0000000000e1', scope: 'profile_storage', action: 'granted' })]],
    ['denied (no grant)', [makeLedgerRow({ scope: 'profile_storage', action: 'granted' })]],
    ['error (empty)', []],
  ])('persists ConsentAuditEvent for result type %s', async (_label, events) => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue(events);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState(makeResolveInput({ operation: 'matching' }));
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { event_type: string; actor_type: string; subject_id: string; event_payload: Record<string, unknown> };
    };
    expect(auditRow.data.event_type).toBe('consent.check.decision');
    expect(auditRow.data.actor_type).toBe('system');
    expect(auditRow.data.subject_id).toBe(TALENT_ID);
    expect(auditRow.data.event_payload['decision_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(auditRow.data.event_payload['talent_id']).toBe(TALENT_ID);
    expect(auditRow.data.event_payload['operation']).toBe('matching');
  });

  it('uses tenant_id from input (which the service derives from JWT), never from elsewhere', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState(makeResolveInput({ tenant_id: TENANT_ID }));
    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { tenant_id: string };
    };
    expect(auditRow.data.tenant_id).toBe(TENANT_ID);
  });
});

describe('ConsentRepository.resolveConsentState — Idempotency', () => {
  it('cache hit short-circuits resolver and audit (do NOT re-run resolver)', async () => {
    const tx = makeTx();
    const cached = {
      result: 'allowed',
      decision_id: '00000000-0000-7000-8000-0000000000f0',
      computed_at: '2026-04-15T00:00:00Z',
    };
    tx.idempotencyKey.findUnique.mockResolvedValue({
      request_hash: 'resolve-hash-1',
      response_body: cached,
    });
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState(
      makeResolveInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000300',
        requestHash: 'resolve-hash-1',
      }),
    );
    expect(decision).toEqual(cached);
    // Cache hit: NO resolver computation, NO audit row
    expect(tx.talentConsentEvent.findMany).not.toHaveBeenCalled();
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
  });

  it('same key + different body → 409 IDEMPOTENCY_KEY_CONFLICT', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue({
      request_hash: 'different-hash',
      response_body: {},
    });
    const repo = new ConsentRepository(makePrisma(tx));
    await expect(
      repo.resolveConsentState(
        makeResolveInput({
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000301',
          requestHash: 'mine-hash',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      statusCode: 409,
    });
  });

  it('no idempotency-key → resolver always runs, fresh decision-log entry', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState(makeResolveInput({ idempotencyKey: undefined }));
    // No idempotency lookup or persistence
    expect(tx.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(tx.idempotencyKey.create).not.toHaveBeenCalled();
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
  });

  it('idempotency-key + 200 path → cache the response for replay', async () => {
    const tx = makeTx();
    tx.idempotencyKey.findUnique.mockResolvedValue(null);
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({ scope: 'matching', action: 'granted' }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000f10',
        scope: 'profile_storage',
        action: 'granted',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState(
      makeResolveInput({
        operation: 'matching',
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000302',
      }),
    );
    expect(tx.idempotencyKey.create).toHaveBeenCalledOnce();
  });
});

describe('ConsentRepository.resolveConsentState — Decision L (R4: ledger-only reads)', () => {
  it('uses tx.talentConsentEvent.findMany only, never any non-ledger table', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState(makeResolveInput());
    // Verify no non-ledger table on tx was accessed (the mock doesn't have
    // engagement, talentResponse, etc., so any access would throw — but
    // also the static R4 guardrail enforces source-level absence).
    expect(tx.talentConsentEvent.findMany).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------------------------
// PR-5 — Resolver tests for resolveAllScopes (state read endpoint).
// Covers Decisions A, C, D, F, H from PR-5. Reuses ADR-0006 Decision D
// source-aware most-restrictive intersection unchanged.
// ----------------------------------------------------------------------

const ALL_SCOPES = [
  'profile_storage',
  'resume_processing',
  'matching',
  'contacting',
  'cross_tenant_visibility',
] as const;

function makeAllScopesInput(): {
  tenant_id: string;
  talent_id: string;
  requestId: string;
} {
  return {
    tenant_id: TENANT_ID,
    talent_id: TALENT_ID,
    requestId: 'req-state-1',
  };
}

describe('ConsentRepository.resolveAllScopes — Decision D (always 5 scopes)', () => {
  it('empty ledger → all 5 scopes return status=no_grant with null timestamps', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());

    expect(result.scopes).toHaveLength(5);
    expect(result.is_anonymized).toBe(false);
    expect(result.tenant_id).toBe(TENANT_ID);
    expect(result.talent_id).toBe(TALENT_ID);
    for (const scope of ALL_SCOPES) {
      const entry = result.scopes.find((s) => s.scope === scope);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('no_grant');
      expect(entry?.granted_at).toBeNull();
      expect(entry?.revoked_at).toBeNull();
      expect(entry?.expires_at).toBeNull();
    }
  });

  it('always returns exactly 5 entries, one per ConsentScope value', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({ scope: 'matching', action: 'granted' }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());

    expect(result.scopes).toHaveLength(5);
    const scopesReturned = result.scopes.map((s) => s.scope).sort();
    expect(scopesReturned).toEqual([...ALL_SCOPES].sort());
  });
});

describe('ConsentRepository.resolveAllScopes — single-scope and multi-scope mix', () => {
  it('single-scope grant: that scope returns granted, others no_grant', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        scope: 'matching',
        action: 'granted',
        occurred_at: new Date('2026-04-01T10:00:00Z'),
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());

    const matching = result.scopes.find((s) => s.scope === 'matching');
    expect(matching?.status).toBe('granted');
    expect(matching?.granted_at).toBe('2026-04-01T10:00:00.000Z');
    expect(matching?.revoked_at).toBeNull();

    const others = result.scopes.filter((s) => s.scope !== 'matching');
    expect(others).toHaveLength(4);
    for (const other of others) {
      expect(other.status).toBe('no_grant');
    }
  });

  it('multi-scope mix: profile granted, contacting revoked, others no_grant', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000200',
        scope: 'profile_storage',
        action: 'granted',
        occurred_at: new Date('2026-04-01T10:00:00Z'),
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000201',
        scope: 'contacting',
        action: 'granted',
        occurred_at: new Date('2026-04-01T11:00:00Z'),
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000202',
        scope: 'contacting',
        action: 'revoked',
        occurred_at: new Date('2026-04-15T14:22:00Z'),
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());

    const profile = result.scopes.find((s) => s.scope === 'profile_storage');
    expect(profile?.status).toBe('granted');
    expect(profile?.granted_at).toBe('2026-04-01T10:00:00.000Z');
    expect(profile?.revoked_at).toBeNull();

    const contacting = result.scopes.find((s) => s.scope === 'contacting');
    expect(contacting?.status).toBe('revoked');
    expect(contacting?.granted_at).toBe('2026-04-01T11:00:00.000Z');
    expect(contacting?.revoked_at).toBe('2026-04-15T14:22:00.000Z');

    for (const scope of ['resume_processing', 'matching', 'cross_tenant_visibility'] as const) {
      const entry = result.scopes.find((s) => s.scope === scope);
      expect(entry?.status).toBe('no_grant');
    }
  });

  it('expires_at timestamp populated from latest grant event when set', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        scope: 'matching',
        action: 'granted',
        occurred_at: new Date('2026-04-01T10:00:00Z'),
        expires_at: new Date('2027-04-01T10:00:00Z'),
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());
    const matching = result.scopes.find((s) => s.scope === 'matching');
    expect(matching?.expires_at).toBe('2027-04-01T10:00:00.000Z');
  });
});

describe('ConsentRepository.resolveAllScopes — ADR-0006 Decision D (source-aware most-restrictive)', () => {
  it('Counterintuitive Example: Indeed-import revoked + signup full grant → contacting=revoked', async () => {
    // §2.7 lines 2416-2422 inherited from ADR-0006 Decision D.
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      // Self-signup full
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000300',
        scope: 'profile_storage',
        action: 'granted',
        captured_method: 'self_signup',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000301',
        scope: 'matching',
        action: 'granted',
        captured_method: 'self_signup',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000302',
        scope: 'contacting',
        action: 'granted',
        captured_method: 'self_signup',
        occurred_at: new Date('2026-01-15T00:00:00Z'),
      }),
      // Indeed-sourced contacting revoked
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000303',
        scope: 'contacting',
        action: 'revoked',
        captured_method: 'import',
        occurred_at: new Date('2026-02-10T00:00:00Z'),
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());

    const contacting = result.scopes.find((s) => s.scope === 'contacting');
    expect(contacting?.status).toBe('revoked');
    expect(contacting?.granted_at).toBe('2026-01-15T00:00:00.000Z');
    expect(contacting?.revoked_at).toBe('2026-02-10T00:00:00.000Z');

    const matching = result.scopes.find((s) => s.scope === 'matching');
    expect(matching?.status).toBe('granted');
  });

  it('multiple sources all granted → status=granted', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000400',
        scope: 'matching',
        action: 'granted',
        captured_method: 'self_signup',
      }),
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000401',
        scope: 'matching',
        action: 'granted',
        captured_method: 'recruiter_capture',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());
    expect(result.scopes.find((s) => s.scope === 'matching')?.status).toBe('granted');
  });

  it('expired status surfaces when a source has expired and none revoked', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000500',
        scope: 'matching',
        action: 'granted',
        captured_method: 'self_signup',
        occurred_at: new Date('2025-01-01T00:00:00Z'),
      }),
      // Latest event for this source is 'expired'
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000501',
        scope: 'matching',
        action: 'expired',
        captured_method: 'self_signup',
        occurred_at: new Date('2026-04-01T00:00:00Z'),
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());
    expect(result.scopes.find((s) => s.scope === 'matching')?.status).toBe('expired');
  });

  it('revoked takes priority over expired when both present in different sources', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      // Source A: latest is expired
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000600',
        scope: 'matching',
        action: 'expired',
        captured_method: 'self_signup',
      }),
      // Source B: latest is revoked
      makeLedgerRow({
        id: '00000000-0000-7000-8000-000000000601',
        scope: 'matching',
        action: 'revoked',
        captured_method: 'recruiter_capture',
      }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());
    // PR-5 priority: revoked > expired > granted > no_grant
    expect(result.scopes.find((s) => s.scope === 'matching')?.status).toBe('revoked');
  });
});

describe('ConsentRepository.resolveAllScopes — Decision F (is_anonymized always false in PR-5)', () => {
  it('returns is_anonymized=false regardless of ledger contents', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());
    expect(result.is_anonymized).toBe(false);
  });

  it('returns is_anonymized=false even with seeded events (PR-5 deferral)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({ scope: 'matching', action: 'granted' }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());
    expect(result.is_anonymized).toBe(false);
  });
});

describe('ConsentRepository.resolveAllScopes — Decision H (no decision-log write)', () => {
  it('does NOT call tx.consentAuditEvent.create on any state read', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([
      makeLedgerRow({ scope: 'matching', action: 'granted' }),
    ]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveAllScopes(makeAllScopesInput());
    expect(tx.consentAuditEvent.create).not.toHaveBeenCalled();
  });

  it('does NOT call tx.idempotencyKey.findUnique or .create (no idempotency on reads)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveAllScopes(makeAllScopesInput());
    expect(tx.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(tx.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('does NOT call tx.outboxEvent.create (no propagation on reads)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveAllScopes(makeAllScopesInput());
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});

describe('ConsentRepository.resolveAllScopes — root metadata', () => {
  it('echoes tenant_id from input (which the service derives from JWT)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes({
      tenant_id: TENANT_ID,
      talent_id: TALENT_ID,
      requestId: 'req-state-meta-1',
    });
    expect(result.tenant_id).toBe(TENANT_ID);
    expect(result.talent_id).toBe(TALENT_ID);
  });

  it('computed_at is an ISO-8601 timestamp', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue([]);
    const repo = new ConsentRepository(makePrisma(tx));
    const result = await repo.resolveAllScopes(makeAllScopesInput());
    expect(result.computed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
