import { describe, expect, it, vi } from 'vitest';

import { IntelligenceRejectedError, IntelligenceUnavailableError, type IntelligenceClient } from '../lib/intelligence-client.js';
import { INBOUND_MAX_ATTEMPTS, IntelligenceInboundSyncService } from '../lib/intelligence-inbound-sync.service.js';

// ATI-SEP-1 T8 — inbound sync outcomes: skip / retry / quarantine (unit; fakes).
// The policy matrix against a real talent_record schema is in
// apps/api/src/tests/ati-sep-1-intelligence-integration.integration.spec.ts.

const ROW = {
  event_id: 'd1',
  tenant_id: '11111111-1111-7111-8111-111111111111',
  talent_record_id: '22222222-2222-7222-8222-222222222222',
  intelligence_subject_id: '33333333-3333-7333-8333-333333333333',
  changed_fact_types: ['TITLE'],
  occurred_at: new Date(),
  attempts: 1,
};

function make(opts: { configured?: boolean; caps?: string[]; read?: () => Promise<unknown> } = {}) {
  const client = { configured: opts.configured ?? true, readProfile: vi.fn(opts.read ?? (async () => ({ intelligence_subject_id: ROW.intelligence_subject_id, facts: [] }))) };
  const records = {
    readAdmissibleRecord: vi.fn(async () => ({ email2: null, phone_cell: null, phone_home: null, phone_work: null, work_authorization: null })),
    readWritableValues: vi.fn(async () => ({})),
    listSyncPolicy: vi.fn(async () => new Map()),
    upsertLink: vi.fn(async () => true),
    completeInboundEvent: vi.fn(async () => undefined),
    retryInboundEventLater: vi.fn(async () => undefined),
    applyIntelligenceField: vi.fn(),
    recordIntelligenceReview: vi.fn(),
  };
  const svc = new IntelligenceInboundSyncService(
    client as unknown as IntelligenceClient,
    { getCapabilities: vi.fn(async () => new Set(opts.caps ?? ['intelligence'])) } as never,
    records as never,
    { listProfileFieldStates: vi.fn(async () => []) } as never,
    { readEvidenceForIntelligence: vi.fn(async () => ({ skills: [], work_history: [], education: [], certifications: [], projects: [], work_authorizations: [] })) } as never,
  );
  return { svc, client, records };
}

describe('ATI-SEP-1 T8 — IntelligenceInboundSyncService.process', () => {
  it('not configured / not entitled → SKIPPED, TI never read', async () => {
    for (const [opts, outcome] of [[{ configured: false }, 'TI_NOT_CONFIGURED'], [{ caps: ['ats'] }, 'NOT_ENTITLED']] as const) {
      const t = make(opts);
      await expect(t.svc.process(ROW)).resolves.toMatchObject({ status: 'SKIPPED', outcome });
      expect(t.client.readProfile).not.toHaveBeenCalled();
      expect(t.records.completeInboundEvent).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'd1', status: 'SKIPPED', outcome }));
    }
  });

  it('a 404 / 403 read refusal is final → SKIPPED', async () => {
    const t = make({ read: async () => Promise.reject(new IntelligenceRejectedError(404, 'REFERENCE_NOT_FOUND', 'x')) });
    await expect(t.svc.process(ROW)).resolves.toMatchObject({ status: 'SKIPPED', outcome: 'READ_REFUSED_REFERENCE_NOT_FOUND' });
  });

  it('TI unavailable → RETRY with a backoff lease; past the attempt budget → QUARANTINED', async () => {
    const t = make({ read: async () => Promise.reject(new IntelligenceUnavailableError('down', 503)) });
    const now = new Date('2026-10-23T00:00:00Z');
    await expect(t.svc.process({ ...ROW, attempts: 2 }, now)).resolves.toMatchObject({ status: 'RETRY' });
    expect(t.records.retryInboundEventLater).toHaveBeenCalledWith({ event_id: 'd1', error: 'down', retry_at: new Date(now.getTime() + 10_000) });
    await expect(t.svc.process({ ...ROW, attempts: INBOUND_MAX_ATTEMPTS }, now)).resolves.toMatchObject({ status: 'QUARANTINED', outcome: 'TI_UNAVAILABLE' });
  });

  it('a read links the Golden subject (intelligence_link) with last_synced_at', async () => {
    const t = make();
    const now = new Date('2026-10-23T00:00:00Z');
    await expect(t.svc.process(ROW, now)).resolves.toMatchObject({ status: 'APPLIED', outcome: 'applied=0 review=0 ignored=0' });
    expect(t.records.upsertLink).toHaveBeenCalledWith({ tenant_id: ROW.tenant_id, talent_record_id: ROW.talent_record_id, intelligence_subject_id: ROW.intelligence_subject_id, synced_at: now });
  });
});
