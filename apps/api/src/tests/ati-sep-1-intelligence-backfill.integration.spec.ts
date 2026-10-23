import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { validateTalentIngestRequest } from '@aramo/intelligence-contracts';
import {
  IntelligenceBackfillService,
  IntelligenceClient,
  IntelligenceEntitlementSyncService,
  loadIntelligenceConfig,
} from '@aramo/intelligence-integration';
import { PrismaService as EvidencePrismaService, TalentEvidenceRepository } from '@aramo/talent-evidence';
import { TalentIntelligenceRepository, TalentRecordPrismaService, TalentRecordRepository } from '@aramo/talent-record';

import { collectIntelligenceIntegrationMigrations, splitDdl } from './support/intelligence-integration-migrations.js';

// ATI-SEP-1 — the Talent Intelligence BACKFILL against a REAL Postgres 17 (the
// documents + talent_evidence + talent_record + entitlement migrations) and a
// STUBBED Talent Intelligence HTTP server (node:http — the real client and the
// real fetch; the ATS reaches TI over HTTP only, nothing from scope:intelligence
// is loaded). The stub keeps an inbox keyed on source_event_id, like TI:
//   * 3 live talents of an entitled tenant → 3 ingests (+ links), REPLACE sync first;
//   * a second run over unchanged data → 3 replayed (deterministic event ids);
//   * a superseded record and an unentitled tenant's record are never sent.


const TENANT = '11111111-1111-7111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-7222-8222-222222222222';
const ACTOR = '33333333-3333-7333-8333-333333333333';
const SUBJECT_PREFIX = '55555555-5555-7555-8555-';

/** A stub Talent Intelligence: token, entitlement sync, and an idempotent ingest inbox. */
function startStubTi(): Promise<{ server: Server; url: string; calls: string[]; ingested: unknown[]; syncs: unknown[] }> {
  const calls: string[] = [];
  const ingested: unknown[] = [];
  const syncs: unknown[] = [];
  const inbox = new Map<string, Record<string, unknown>>();
  let n = 0;
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const path = req.url ?? '';
      calls.push(`${req.method} ${path}`);
      const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (path === '/v1/oauth/token') return send(res, 200, { access_token: 'tok', token_type: 'Bearer', expires_in: 900, scope: 'x' });
      if (req.headers['authorization'] !== 'Bearer tok') return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'no' } });
      if (path === '/v1/entitlements/sync') {
        syncs.push(body);
        return send(res, 200, { applied: (body['tenants'] as unknown[]).length, deactivated: 0 });
      }
      if (path === '/v1/ingest/talent') {
        const verdict = validateTalentIngestRequest(body);
        if (!verdict.ok) return send(res, 400, { error: { code: verdict.code, message: 'refused' } });
        const eventId = String(body['source_event_id']);
        const prior = inbox.get(eventId);
        if (prior !== undefined) return send(res, 200, { ...prior, replayed: true });
        ingested.push(body);
        n += 1;
        const response = {
          intelligence_subject_id: `${SUBJECT_PREFIX}${String(n).padStart(12, '0')}`,
          outcome: 'CREATED',
          resolution: 'NEW_PROVISIONAL',
          changed: true,
          assertions_added: (body['assertions'] as unknown[]).length,
          assertions_superseded: 0,
          conflicts_opened: 0,
          replayed: false,
        };
        inbox.set(eventId, response);
        return send(res, 200, response);
      }
      return send(res, 404, { error: { code: 'NOT_FOUND', message: path } });
    });
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, ingested, syncs })),
  );
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ATI-SEP-1 — Talent Intelligence backfill (real Postgres 17 + stub TI HTTP)', () => {
  let container: StartedPostgreSqlContainer;
  let recordPrisma: TalentRecordPrismaService;
  let evidencePrisma: EvidencePrismaService;
  let ti: Awaited<ReturnType<typeof startStubTi>>;
  let service: IntelligenceBackfillService;
  const ids: string[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    const setup = new EvidencePrismaService(url);
    await setup.$connect();
    for (const path of collectIntelligenceIntegrationMigrations()) {
      for (const stmt of splitDdl(readFileSync(path, 'utf8'))) await setup.$executeRawUnsafe(stmt);
    }
    await setup.$disconnect();
    evidencePrisma = new EvidencePrismaService(url);
    await evidencePrisma.$connect();
    recordPrisma = new TalentRecordPrismaService(url);
    await recordPrisma.$connect();

    const entitlements = {
      getCapabilities: async (t: string) =>
        new Set(
          (await recordPrisma.$queryRawUnsafe<Array<{ c: string }>>(`SELECT capability::text AS c FROM "entitlement"."TenantEntitlement" WHERE tenant_id = $1::uuid`, t)).map((r) => r.c),
        ),
      listTenantIdsWithCapability: async (c: string) =>
        (
          await recordPrisma.$queryRawUnsafe<Array<{ t: string }>>(
            `SELECT tenant_id::text AS t FROM "entitlement"."TenantEntitlement" WHERE capability::text = $1 ORDER BY tenant_id`,
            c,
          )
        ).map((r) => r.t),
    };
    for (const [tenant, caps] of [
      [TENANT, ['core', 'ats', 'intelligence']],
      [OTHER_TENANT, ['core', 'ats']],
    ] as const) {
      for (const c of caps) {
        await recordPrisma.$executeRawUnsafe(`INSERT INTO "entitlement"."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, $2::"entitlement"."Capability")`, tenant, c);
      }
    }

    const records = new TalentRecordRepository(recordPrisma);
    for (const [tenant, i] of [
      [TENANT, 1],
      [TENANT, 2],
      [TENANT, 3],
      [TENANT, 4],
      [OTHER_TENANT, 5],
    ] as const) {
      const view = await records.create({
        tenant_id: tenant,
        entered_by_id: ACTOR,
        input: { first_name: `First${i}`, last_name: `Last${i}`, email1: `t${i}@example.com`, phone_cell: `(555) 123-000${i}`, city: 'Austin', state: 'TX', current_employer: 'Acme' } as never,
      });
      ids.push(view.id);
    }
    // Record 4 is superseded (not live) → never replayed.
    await recordPrisma.$executeRawUnsafe(`UPDATE "talent_record"."TalentRecord" SET record_status = 'superseded' WHERE id = $1::uuid`, ids[3]);

    ti = await startStubTi();
    const client = new IntelligenceClient(
      loadIntelligenceConfig({ INTELLIGENCE_SERVICE_URL: ti.url, INTELLIGENCE_ATS_CLIENT_ID: 'aramo-ats', INTELLIGENCE_ATS_CLIENT_SECRET: 's'.repeat(40) }),
    );
    service = new IntelligenceBackfillService(
      client,
      entitlements as never,
      new IntelligenceEntitlementSyncService(client, entitlements as never),
      new TalentIntelligenceRepository(recordPrisma),
      new TalentEvidenceRepository(evidencePrisma),
    );
  }, 240_000);

  afterAll(async () => {
    if (ti !== undefined) await new Promise((r) => ti.server.close(r));
    await recordPrisma?.$disconnect();
    await evidencePrisma?.$disconnect();
    await container?.stop();
  });

  it('dry-run validates the 3 live payloads and sends nothing', async () => {
    const s = await service.run({ dryRun: true });
    expect(s).toMatchObject({ scanned: 3, validated: 3, ingested: 0, replayed: 0, rejected: 0, failed: 0 });
    expect(ti.calls).toEqual([]);
    expect(await recordPrisma.intelligenceLink.count()).toBe(0);
  });

  it('first run: REPLACE entitlement sync, then 3 live talents → 3 ingests + 3 links', async () => {
    const s = await service.run({ pageSize: 2 });
    expect(s).toMatchObject({ tenants: [TENANT], scanned: 3, ingested: 3, replayed: 0, rejected: 0, failed: 0, not_entitled: 0 });
    expect(ti.syncs).toEqual([{ source_system_id: 'ARAMO_ATS', mode: 'REPLACE', tenants: [{ tenant_id: TENANT, active: true }] }]);
    const firstIngest = ti.calls.findIndex((c) => c === 'POST /v1/ingest/talent');
    expect(ti.calls.indexOf('POST /v1/entitlements/sync')).toBeLessThan(firstIngest);
    expect(ti.ingested).toHaveLength(3);
    const sent = (ti.ingested as Array<{ external_talent_id: string; source_tenant_id: string }>).map((b) => b.external_talent_id).sort();
    expect(sent).toEqual([ids[0], ids[1], ids[2]].sort());
    expect(await recordPrisma.intelligenceLink.count({ where: { tenant_id: TENANT } })).toBe(3);
    expect(await recordPrisma.intelligenceLink.count({ where: { talent_record_id: { in: [ids[3] as string, ids[4] as string] } } })).toBe(0);
  });

  it('second run over unchanged data → 3 replayed (idempotent), nothing new ingested', async () => {
    const s = await service.run();
    expect(s).toMatchObject({ scanned: 3, ingested: 0, replayed: 3, rejected: 0, failed: 0 });
    expect(ti.ingested).toHaveLength(3);
  });

  it('an explicit unentitled tenant is refused (not_entitled) and never read or sent', async () => {
    const before = ti.calls.length;
    const s = await service.run({ tenants: [OTHER_TENANT] });
    expect(s).toMatchObject({ tenants: [], scanned: 0, not_entitled: 1 });
    expect(ti.calls.length).toBe(before);
  });
});
