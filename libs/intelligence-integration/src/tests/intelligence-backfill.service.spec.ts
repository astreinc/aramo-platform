import { describe, expect, it, vi } from 'vitest';
import type { TalentIngestRequest } from '@aramo/intelligence-contracts';

import { IntelligenceBackfillService, BackfillRefusedError, backfillContentHash, backfillEventId } from '../lib/intelligence-backfill.service.js';
import { IntelligenceRejectedError, IntelligenceUnavailableError, type IntelligenceClient } from '../lib/intelligence-client.js';
import type { IntelligenceEntitlementSyncService } from '../lib/intelligence-entitlement-sync.service.js';

// ATI-SEP-1 — the Talent Intelligence backfill (unit; fake client + fake stores).

const T_A = '11111111-1111-7111-8111-111111111111';
const T_B = '22222222-2222-7222-8222-222222222222';
const T_OFF = '99999999-9999-7999-8999-999999999999';
const SUBJECT = '55555555-5555-7555-8555-555555555555';

const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function record(tenant: string, n: number, over: Record<string, unknown> = {}) {
  return {
    id: id(n),
    tenant_id: tenant,
    record_status: 'live',
    first_name: `First${n}`,
    last_name: `Last${n}`,
    email1: `t${n}@example.com`,
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
    ...over,
  };
}
const EMPTY_EVIDENCE = { skills: [], work_history: [], education: [], certifications: [], projects: [], work_authorizations: [] };

type Rec = ReturnType<typeof record>;

function make(
  opts: {
    entitled?: string[];
    data?: Record<string, Rec[]>;
    ingest?: (req: TalentIngestRequest) => Promise<unknown>;
    configured?: boolean;
  } = {},
) {
  const data = opts.data ?? { [T_A]: [1, 2, 3].map((n) => record(T_A, n)) };
  const inbox = new Set<string>();
  const client = {
    configured: opts.configured ?? true,
    ingestTalent: vi.fn(
      opts.ingest ??
        (async (req: TalentIngestRequest) => {
          const replayed = inbox.has(req.source_event_id);
          inbox.add(req.source_event_id);
          return { intelligence_subject_id: SUBJECT, outcome: 'CREATED', replayed };
        }),
    ),
  };
  const entitlements = { listTenantIdsWithCapability: vi.fn(async () => opts.entitled ?? [T_A, T_B]) };
  const sync = { replaceAll: vi.fn(async () => ({ applied: 2, deactivated: 0 })) };
  const records = {
    listLiveAdmissibleRecordsPage: vi.fn(async (a: { tenant_id: string; after?: string | null; limit: number }) =>
      (data[a.tenant_id] ?? [])
        .filter((r) => r.record_status === 'live' && (a.after ? r.id > a.after : true))
        .sort((x, y) => x.id.localeCompare(y.id))
        .slice(0, a.limit),
    ),
    listIntelligenceSourcedFields: vi.fn(async () => new Set<string>()),
    upsertLink: vi.fn(async () => true),
  };
  const evidence = { readEvidenceForIntelligence: vi.fn(async () => EMPTY_EVIDENCE) };
  class Svc extends IntelligenceBackfillService {
    sleeps: number[] = [];
    protected override async sleep(ms: number): Promise<void> {
      this.sleeps.push(ms);
    }
  }
  const svc = new Svc(
    client as unknown as IntelligenceClient,
    entitlements as never,
    sync as unknown as IntelligenceEntitlementSyncService,
    records as never,
    evidence as never,
  );
  return { svc, client, entitlements, sync, records, evidence, inbox };
}

describe('ATI-SEP-1 — IntelligenceBackfillService', () => {
  it('backfills every entitled tenant: REPLACE sync first, then one ingest per live record, links written', async () => {
    const t = make({ data: { [T_A]: [record(T_A, 1), record(T_A, 2)], [T_B]: [record(T_B, 3)] } });
    const s = await t.svc.run();
    expect(t.sync.replaceAll).toHaveBeenCalledTimes(1);
    expect(t.sync.replaceAll.mock.invocationCallOrder[0]).toBeLessThan(t.client.ingestTalent.mock.invocationCallOrder[0] as number);
    expect(s).toMatchObject({ tenants: [T_A, T_B], scanned: 3, ingested: 3, replayed: 0, rejected: 0, failed: 0, not_entitled: 0 });
    expect(t.records.upsertLink).toHaveBeenCalledTimes(3);
    expect(s.cursors).toEqual({ [T_A]: id(2), [T_B]: id(3) });
  });

  it('an explicit tenant without the capability is refused (not_entitled), never read or sent', async () => {
    const t = make({ entitled: [T_A], data: { [T_A]: [record(T_A, 1)], [T_OFF]: [record(T_OFF, 2)] } });
    const s = await t.svc.run({ tenants: [T_A, T_OFF] });
    expect(s).toMatchObject({ tenants: [T_A], scanned: 1, ingested: 1, not_entitled: 1 });
    expect(t.records.listLiveAdmissibleRecordsPage.mock.calls.every(([a]) => a.tenant_id === T_A)).toBe(true);
    expect(t.client.ingestTalent.mock.calls.every(([r]) => r.source_tenant_id === T_A)).toBe(true);
  });

  it('only entitled tenants by default; none entitled → no sync, no ingest', async () => {
    const t = make({ entitled: [] });
    const s = await t.svc.run();
    expect(s).toMatchObject({ tenants: [], scanned: 0, ingested: 0 });
    expect(t.sync.replaceAll).not.toHaveBeenCalled();
    expect(t.client.ingestTalent).not.toHaveBeenCalled();
  });

  it('source_event_id is deterministic (uuidv5 over tenant, talent and content hash) and changes with content', async () => {
    const a = make();
    await a.svc.run();
    const b = make();
    await b.svc.run();
    const idsA = a.client.ingestTalent.mock.calls.map(([r]) => r.source_event_id);
    const idsB = b.client.ingestTalent.mock.calls.map(([r]) => r.source_event_id);
    expect(idsA).toEqual(idsB);
    expect(new Set(idsA).size).toBe(3);
    const first = a.client.ingestTalent.mock.calls[0]?.[0] as TalentIngestRequest;
    expect(first.source_event_id).toBe(backfillEventId(T_A, id(1), backfillContentHash(first)));
    expect(first.source_event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.occurred_at).toBe('2026-10-20T00:00:00.000Z');

    const c = make({ data: { [T_A]: [record(T_A, 1, { current_employer: 'Globex' })] } });
    await c.svc.run();
    expect(c.client.ingestTalent.mock.calls[0]?.[0].source_event_id).not.toBe(first.source_event_id);
  });

  it('a re-run is idempotent: TI replayed:true counts as success', async () => {
    const t = make();
    const one = await t.svc.run();
    const two = await t.svc.run();
    expect(one).toMatchObject({ ingested: 3, replayed: 0, failed: 0 });
    expect(two).toMatchObject({ ingested: 0, replayed: 3, failed: 0, rejected: 0 });
  });

  it('a TI refusal is skipped and recorded by reason code only (no payload value)', async () => {
    const t = make({
      ingest: async (req) => {
        if (req.external_talent_id === id(2)) throw new IntelligenceRejectedError(400, 'CLASS_C_REJECTED', 'refused', { path: '$.x' });
        return { intelligence_subject_id: SUBJECT, replayed: false };
      },
    });
    const s = await t.svc.run();
    expect(s).toMatchObject({ scanned: 3, ingested: 2, rejected: 1, failed: 0, rejected_by_code: { TI_400_CLASS_C_REJECTED: 1 } });
    expect(s.rejections).toEqual([{ tenant_id: T_A, talent_id: id(2), code: 'TI_400_CLASS_C_REJECTED' }]);
  });

  it('a payload the admission validator refuses is skipped by code and never sent', async () => {
    // An envelope id with spaces cannot pass the validator: the build fails closed.
    const bad = record(T_A, 2, { id: `${id(2)} bad id` });
    const t = make({ data: { [T_A]: [record(T_A, 1), bad] } });
    const s = await t.svc.run();
    expect(s.rejected).toBe(1);
    expect(Object.keys(s.rejected_by_code)[0]).toMatch(/^VALIDATOR_/);
    expect(t.client.ingestTalent).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 with exponential backoff, then succeeds', async () => {
    let calls = 0;
    const t = make({
      data: { [T_A]: [record(T_A, 1)] },
      ingest: async () => {
        calls += 1;
        if (calls < 3) throw new IntelligenceUnavailableError('Talent Intelligence answered 503', 503);
        return { intelligence_subject_id: SUBJECT, replayed: false };
      },
    });
    const s = await t.svc.run({ baseBackoffMs: 100 });
    expect(s).toMatchObject({ ingested: 1, failed: 0 });
    expect(calls).toBe(3);
    expect((t.svc as unknown as { sleeps: number[] }).sleeps).toEqual([100, 200]);
  });

  it('a 503 past maxAttempts is counted failed', async () => {
    const t = make({
      data: { [T_A]: [record(T_A, 1)] },
      ingest: async () => {
        throw new IntelligenceUnavailableError('Talent Intelligence answered 503', 503);
      },
    });
    const s = await t.svc.run({ maxAttempts: 3, baseBackoffMs: 1 });
    expect(s).toMatchObject({ ingested: 0, failed: 1 });
    expect(t.client.ingestTalent).toHaveBeenCalledTimes(3);
  });

  it('dry-run builds and validates every payload but sends nothing (no sync, no ingest, no link)', async () => {
    const t = make({ configured: false });
    const s = await t.svc.run({ dryRun: true });
    expect(s).toMatchObject({ dry_run: true, scanned: 3, validated: 3, ingested: 0 });
    expect(t.sync.replaceAll).not.toHaveBeenCalled();
    expect(t.client.ingestTalent).not.toHaveBeenCalled();
    expect(t.records.upsertLink).not.toHaveBeenCalled();
    expect(t.evidence.readEvidenceForIntelligence).toHaveBeenCalledTimes(3);
  });

  it('resumes after a cursor, pages by id, honours --limit', async () => {
    const t = make({ data: { [T_A]: [1, 2, 3, 4, 5].map((n) => record(T_A, n)) } });
    const s = await t.svc.run({ tenants: [T_A], after: id(2), pageSize: 2 });
    expect(t.client.ingestTalent.mock.calls.map(([r]) => r.external_talent_id)).toEqual([id(3), id(4), id(5)]);
    expect(s).toMatchObject({ scanned: 3, ingested: 3 });
    expect(s.cursors[T_A]).toBe(id(5));

    const l = make({ data: { [T_A]: [1, 2, 3, 4, 5].map((n) => record(T_A, n)) } });
    const sl = await l.svc.run({ limit: 2, pageSize: 10 });
    expect(sl).toMatchObject({ scanned: 2, ingested: 2 });
    expect(sl.cursors[T_A]).toBe(id(2));
  });

  it('refuses: not configured (non dry-run), cursor without exactly one tenant, malformed ids', async () => {
    await expect(make({ configured: false }).svc.run()).rejects.toBeInstanceOf(BackfillRefusedError);
    await expect(make().svc.run({ after: id(1) })).rejects.toMatchObject({ code: 'CURSOR_NEEDS_ONE_TENANT' });
    await expect(make().svc.run({ tenants: ['x'] })).rejects.toMatchObject({ code: 'INVALID_TENANT' });
    await expect(make().svc.run({ tenants: [T_A], after: 'nope' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('a refused REPLACE entitlement sync aborts before any ingest', async () => {
    const t = make();
    t.sync.replaceAll.mockResolvedValueOnce(null as never);
    await expect(t.svc.run()).rejects.toMatchObject({ code: 'ENTITLEMENT_SYNC_REFUSED' });
    expect(t.client.ingestTalent).not.toHaveBeenCalled();
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const t = make({
      data: { [T_A]: Array.from({ length: 10 }, (_, i) => record(T_A, i + 1)) },
      ingest: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { intelligence_subject_id: SUBJECT, replayed: false };
      },
    });
    const s = await t.svc.run({ concurrency: 3 });
    expect(s.ingested).toBe(10);
    expect(peak).toBe(3);
  });
});
