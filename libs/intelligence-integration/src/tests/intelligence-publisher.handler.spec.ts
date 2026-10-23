import { describe, expect, it, vi } from 'vitest';
import type { AramoEventEnvelope } from '@aramo/events';
import type { TalentEventPayload } from '@aramo/talent-record';

import { IntelligenceRejectedError, IntelligenceUnavailableError, type IntelligenceClient } from '../lib/intelligence-client.js';
import type { IntelligenceEntitlementSyncService } from '../lib/intelligence-entitlement-sync.service.js';
import { IntelligencePublisherHandler } from '../lib/intelligence-publisher.handler.js';

// ATI-SEP-1 T8 — the Intelligence publisher's outcomes (unit; fakes only).

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = '22222222-2222-7222-8222-222222222222';

function envelope(event_type: string): AramoEventEnvelope<TalentEventPayload> {
  return {
    event_id: '0190aaaa-0000-7000-8000-000000000001',
    event_type,
    event_version: 'v1',
    tenant_id: TENANT,
    source: 'ats-talent-record',
    subject_type: 'talent_record',
    subject_id: TALENT,
    occurred_at: '2026-10-23T10:00:00.000Z',
    correlation_id: 'c',
    causation_id: null,
    payload: { talent_record_id: TALENT },
  };
}

const RECORD = {
  id: TALENT,
  tenant_id: TENANT,
  record_status: 'live',
  first_name: 'Ada',
  last_name: 'Lovelace',
  email1: 'ada@example.com',
  email2: null,
  phone_cell: null,
  phone_home: null,
  phone_work: null,
  city: null,
  state: null,
  country: 'US',
  current_employer: 'Acme',
  title: null,
  web_site: null,
  availability_status: null,
  date_available: null,
  work_authorization: null,
  updated_at: new Date('2026-10-20T00:00:00Z'),
};
const EMPTY_EVIDENCE = { skills: [], work_history: [], education: [], certifications: [], projects: [], work_authorizations: [] };

function make(opts: { configured?: boolean; capabilities?: string[]; ingest?: () => Promise<unknown>; record?: unknown } = {}) {
  const client = {
    configured: opts.configured ?? true,
    ingestTalent: vi.fn(opts.ingest ?? (async () => ({ intelligence_subject_id: '33333333-3333-7333-8333-333333333333' }))),
    ingestErased: vi.fn(async () => ({ outcome: 'ERASED' })),
  };
  const entitlements = { getCapabilities: vi.fn(async () => new Set(opts.capabilities ?? ['core', 'ats', 'intelligence'])) };
  const sync = { ensureEntitled: vi.fn(async () => undefined) };
  const records = {
    readAdmissibleRecord: vi.fn(async () => (opts.record === undefined ? RECORD : opts.record)),
    listIntelligenceSourcedFields: vi.fn(async () => new Set<string>()),
    upsertLink: vi.fn(async () => true),
  };
  const evidence = { readEvidenceForIntelligence: vi.fn(async () => EMPTY_EVIDENCE) };
  const handler = new IntelligencePublisherHandler(
    client as unknown as IntelligenceClient,
    entitlements as never,
    sync as unknown as IntelligenceEntitlementSyncService,
    records as never,
    evidence as never,
  );
  return { handler, client, entitlements, sync, records, evidence };
}

describe('ATI-SEP-1 T8 — IntelligencePublisherHandler', () => {
  it('TI not configured → no-op success (TI_NOT_CONFIGURED), no read, no call', async () => {
    const t = make({ configured: false });
    await expect(t.handler.publish(envelope('talent.created'))).resolves.toBe('TI_NOT_CONFIGURED');
    await expect(t.handler.handle(envelope('talent.created'))).resolves.toBeUndefined();
    expect(t.entitlements.getCapabilities).not.toHaveBeenCalled();
    expect(t.client.ingestTalent).not.toHaveBeenCalled();
  });

  it('tenant without the intelligence capability → no-op success (NOT_ENTITLED); nothing read or sent', async () => {
    const t = make({ capabilities: ['core', 'ats', 'portal'] });
    await expect(t.handler.publish(envelope('talent.profile_updated'))).resolves.toBe('NOT_ENTITLED');
    expect(t.records.readAdmissibleRecord).not.toHaveBeenCalled();
    expect(t.client.ingestTalent).not.toHaveBeenCalled();
    expect(t.client.ingestErased).not.toHaveBeenCalled();
  });

  it('entitled talent.created → validated snapshot ingested with source_event_id = the outbox event id; link upserted', async () => {
    const t = make();
    await expect(t.handler.publish(envelope('talent.created'))).resolves.toBe('INGESTED');
    const req = t.client.ingestTalent.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(req).toMatchObject({ source_system_id: 'ARAMO_ATS', source_tenant_id: TENANT, external_talent_id: TALENT, source_event_id: '0190aaaa-0000-7000-8000-000000000001' });
    expect(t.sync.ensureEntitled).toHaveBeenCalledWith(TENANT);
    expect(t.records.upsertLink).toHaveBeenCalledWith({ tenant_id: TENANT, talent_record_id: TALENT, intelligence_subject_id: '33333333-3333-7333-8333-333333333333' });
  });

  it('TI 503 → THROWS (the drain retries with backoff); the link is not touched', async () => {
    const t = make({ ingest: async () => Promise.reject(new IntelligenceUnavailableError('Talent Intelligence answered 503', 503)) });
    await expect(t.handler.handle(envelope('talent.created'))).rejects.toBeInstanceOf(IntelligenceUnavailableError);
    expect(t.records.upsertLink).not.toHaveBeenCalled();
  });

  it('an erased reference (409 REFERENCE_ERASED) is final → no-op; any other refusal is thrown', async () => {
    const erased = make({ ingest: async () => Promise.reject(new IntelligenceRejectedError(409, 'REFERENCE_ERASED', 'erased')) });
    await expect(erased.handler.publish(envelope('talent.profile_updated'))).resolves.toBe('REFERENCE_ERASED');
    const refused = make({ ingest: async () => Promise.reject(new IntelligenceRejectedError(400, 'CLASS_C_REJECTED', 'x')) });
    await expect(refused.handler.publish(envelope('talent.profile_updated'))).rejects.toBeInstanceOf(IntelligenceRejectedError);
  });

  it('talent.erased AND talent.deleted → POST /v1/ingest/talent/erased (TI reference ERASED)', async () => {
    for (const type of ['talent.erased', 'talent.deleted']) {
      const t = make();
      await expect(t.handler.publish(envelope(type))).resolves.toBe('ERASED');
      expect(t.client.ingestErased).toHaveBeenCalledWith({
        source_system_id: 'ARAMO_ATS',
        source_tenant_id: TENANT,
        external_talent_id: TALENT,
        source_event_id: '0190aaaa-0000-7000-8000-000000000001',
        occurred_at: '2026-10-23T10:00:00.000Z',
      });
      expect(t.records.readAdmissibleRecord).not.toHaveBeenCalled();
    }
  });

  it('a record that no longer exists → TALENT_NOT_FOUND (no-op); an unknown event type → IGNORED', async () => {
    const gone = make({ record: null });
    await expect(gone.handler.publish(envelope('talent.created'))).resolves.toBe('TALENT_NOT_FOUND');
    expect(gone.client.ingestTalent).not.toHaveBeenCalled();
    const t = make();
    await expect(t.handler.publish(envelope('talent.something_else'))).resolves.toBe('IGNORED');
  });
});
