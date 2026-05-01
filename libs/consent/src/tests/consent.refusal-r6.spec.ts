import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository } from '../lib/consent.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Charter Refusal R6: no acting on stale consent. PR-4 introduces the
// /consent/check endpoint as the runtime enforcement point for the
// 12-month staleness rule (Group 2 §2.7 Stale Consent, lines 2424-2447).
// The resolver REPORTS staleness via result: "denied" + reason_code:
// "stale_consent". It does NOT *act* on staleness — i.e., it triggers
// no engagement halt, no propagation, no notification. Engagement-layer
// enforcement is a separate concern (deferred until engagement entities
// exist).
//
// This spec verifies the report-not-act semantic mechanically:
//   - Stale contacting → result: denied + reason_code: stale_consent
//   - Same call writes a single ConsentAuditEvent (the decision-log) and
//     no other side effects (no outbox event, no propagation row)
//   - Source code does not reference engagement entities (R4 invariant
//     also covers this; R6 is the "must not ACT" framing)

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';

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
    idempotencyKey: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    talentConsentEvent: {
      create: vi.fn(),
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

function staleContactingLedger() {
  const thirteenMonthsAgo = new Date();
  thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
  return [
    {
      id: '00000000-0000-7000-8000-000000000001',
      scope: 'profile_storage',
      action: 'granted',
      captured_method: 'recruiter_capture',
      occurred_at: thirteenMonthsAgo,
      metadata: null,
    },
    {
      id: '00000000-0000-7000-8000-000000000002',
      scope: 'matching',
      action: 'granted',
      captured_method: 'recruiter_capture',
      occurred_at: thirteenMonthsAgo,
      metadata: null,
    },
    {
      id: '00000000-0000-7000-8000-000000000003',
      scope: 'contacting',
      action: 'granted',
      captured_method: 'recruiter_capture',
      occurred_at: thirteenMonthsAgo,
      metadata: null,
    },
  ];
}

describe('Refusal R6 — no acting on stale consent (resolver reports, does not act)', () => {
  it('stale contacting → result: denied with reason_code: stale_consent (REPORTING)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue(staleContactingLedger());
    const repo = new ConsentRepository(makePrisma(tx));
    const decision = await repo.resolveConsentState({
      tenant_id: TENANT_ID,
      talent_id: TALENT_ID,
      operation: 'engagement',
      channel: 'email',
      requestHash: 'r6-h-1',
      requestId: 'r6-req-1',
    });
    expect(decision.result).toBe('denied');
    expect(decision.reason_code).toBe('stale_consent');
  });

  it('stale-consent decision triggers NO outbox event (no propagation; resolver does not act)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue(staleContactingLedger());
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState({
      tenant_id: TENANT_ID,
      talent_id: TALENT_ID,
      operation: 'engagement',
      channel: 'email',
      requestHash: 'r6-h-2',
      requestId: 'r6-req-2',
    });
    // Resolver path writes only the decision-log audit row. No outbox
    // event for stale-consent (would be acting). Engagement halt is
    // deferred to a future PR with engagement entities.
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it('stale-consent decision writes exactly ONE ConsentAuditEvent (decision-log only)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue(staleContactingLedger());
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState({
      tenant_id: TENANT_ID,
      talent_id: TALENT_ID,
      operation: 'engagement',
      channel: 'email',
      requestHash: 'r6-h-3',
      requestId: 'r6-req-3',
    });
    expect(tx.consentAuditEvent.create).toHaveBeenCalledOnce();
    const auditRow = tx.consentAuditEvent.create.mock.calls[0][0] as {
      data: { event_type: string };
    };
    // Only the decision-log type. No "consent.stale.detected" event,
    // no "engagement.halted" event — those would be ACTING.
    expect(auditRow.data.event_type).toBe('consent.check.decision');
  });

  it('stale-consent decision does NOT write to TalentConsentEvent (no auto-expire mutation)', async () => {
    const tx = makeTx();
    tx.talentConsentEvent.findMany.mockResolvedValue(staleContactingLedger());
    const repo = new ConsentRepository(makePrisma(tx));
    await repo.resolveConsentState({
      tenant_id: TENANT_ID,
      talent_id: TALENT_ID,
      operation: 'engagement',
      channel: 'email',
      requestHash: 'r6-h-4',
      requestId: 'r6-req-4',
    });
    // The resolver MUST NOT auto-write an expired event when it detects
    // staleness. The staleness recomputation background job (deferred,
    // future PR) is the writer of action: "expired"; the resolver only
    // reports.
    expect(tx.talentConsentEvent.create).not.toHaveBeenCalled();
  });
});
