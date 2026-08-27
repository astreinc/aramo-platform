import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportSPKI, generateKeyPair } from 'jose';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';
import {
  ExternalRequisitionIdentityRepository,
  LifecycleSourceAdapterRegistry,
  RequisitionLifecycleMappingRepository,
  SECRETS_MANAGER_PORT,
  buildConnectorSecretRef,
  encodeFieldglassCredential,
  type FieldglassCredentialBundle,
  type LifecycleFetchContext,
  type SecretsManagerPort,
} from '@aramo/integration';

import { AppModule } from '../app.module.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';
import { LifecyclePollProducer } from '../requisition-integration/lifecycle-poll.producer.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';
import { placementCapacityMigrations } from './support/placement-capacity-migrations.js';

// CB-D2-FG (ADR-0030) — the SAP Fieldglass PULL/delta STATE-OBSERVATION lifecycle
// adapter, end-to-end against real Postgres 17 through the full app. The FG token
// endpoint + the Buyer Job Posting delta download connector are FAKED (global
// `fetch` spy) with documented-shape OAGIS StaffingOrder payloads; the REAL
// FieldglassLifecycleSource parses them into provider-neutral observations that
// flow through the A1 ingress + the L1-D1 governed seam. NO live SAP call anywhere.
//
// Proves (directive §RED-first):
//   1. PARSE+OBSERVE — raw <Status> passthrough; provider_event_at/sequence null; confidence unknown.
//   2. GOVERNED EXECUTE — Halted->PUT_ON_HOLD, Closed->CLOSE, Withdrawn->CANCEL, Submitted->REOPEN.
//   3. UNMAPPABLE status -> reconciliation, no mutation.
//   4. UNRESOLVED IDENTITY -> reconciliation (REQUISITION_NOT_FOUND), never opportunistic creation.
//   5. IDEMPOTENCY — same delivery dedups; a NEW delivery re-observing is not collapsed.
//   6. CREDENTIAL — producer resolves secret_ref -> fake OAuth used it; NULL secret_ref -> CONNECTOR_SECRET_UNAVAILABLE, no provider call.
//   7. STATE-OBSERVATION boundary — never kind:'event', never provider_event_at.
//   8. HARD-PROHIBITION (structural) — the FG adapter writes NO requisition state.

const ROOT = resolve(__dirname, '../../../..');

const MIGRATIONS = [
  ...migrationsFor('entitlement'),
  ...migrationsFor('requisition'),
  ...migrationsFor('policy-store'),
  ...migrationsFor('integration'),
  ...placementCapacityMigrations(ROOT),
];

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

const TENANT = '01900000-0000-7000-8000-0000000000fa';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

// The provider-neutral non-secret connection config the producer passes through.
const FG_BASE_URL = 'https://fieldglass.example.test';
const FG_CONNECTOR_NAME = 'buyer_job_posting_delta';
const FG_CONFIG = { base_url: FG_BASE_URL, connector_name: FG_CONNECTOR_NAME };

// The SECRET material (OAuth client credentials) — resolved server-side and handed
// to the adapter as ONE ephemeral opaque string; never read from `config`.
const FG_BUNDLE: FieldglassCredentialBundle = {
  client_id: 'fg-client-abc',
  client_secret: 'fg-secret-xyz',
  application_key: 'fg-app-key-123',
};

let seq = 0;
const uuid = (): string => `00000000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

// -----------------------------------------------------------------------------
// The FAKE Fieldglass endpoint (OAuth token + Buyer Job Posting delta connector).
// Records every call so the proofs can assert the resolved credential was used and
// that a null-credential poll never reaches the provider. The download body is a
// mutable script the proofs set per-poll (delivery/download id + staffing orders).
// -----------------------------------------------------------------------------
interface StaffingOrderFixture { idValue: string; status: string }
interface FakeFg {
  tokenCalls: Array<{ url: string; body: string }>;
  downloadCalls: Array<{ url: string; authorization: string | null }>;
  downloadBody: string;
  contentType: string;
}

function jsonDownload(downloadId: string, orders: StaffingOrderFixture[]): string {
  return JSON.stringify({
    DownloadId: downloadId,
    StaffingOrder: orders.map((o) => ({
      DocumentID: { ID: { IdValue: o.idValue } },
      Status: o.status,
      ValidFrom: '2026-01-01',
      ValidTo: '2026-12-31',
    })),
  });
}

// The documented OAGIS StaffingOrder XML shape (what the connector emits by
// default) — exercised directly in proof 1 to prove the XML parse path.
function xmlDownload(downloadId: string, orders: StaffingOrderFixture[]): string {
  const records = orders
    .map(
      (o) =>
        `<StaffingOrder><DocumentID><ID><IdValue>${o.idValue}</IdValue></ID></DocumentID>` +
        `<Status>${o.status}</Status><ValidFrom>2026-01-01</ValidFrom><ValidTo>2026-12-31</ValidTo></StaffingOrder>`,
    )
    .join('');
  return `<?xml version="1.0"?><StaffingOrderDelta><DownloadId>${downloadId}</DownloadId>${records}</StaffingOrderDelta>`;
}

function installFakeFg(fake: FakeFg): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const headers = new Headers(init?.headers ?? {});
      const ok = (body: string, contentType: string): Response =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': contentType }),
          text: async () => body,
          json: async () => JSON.parse(body),
        }) as unknown as Response;

      if (u.includes('oauth')) {
        fake.tokenCalls.push({ url: u, body: String(init?.body ?? '') });
        return ok(JSON.stringify({ access_token: 'fg-access-token', token_type: 'Bearer', expires_in: 3600 }), 'application/json');
      }
      if (u.includes('/connector/')) {
        fake.downloadCalls.push({ url: u, authorization: headers.get('authorization') });
        return ok(fake.downloadBody, fake.contentType);
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
  );
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CB-D2-FG — SAP Fieldglass state-observation lifecycle adapter (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let storePrisma: PolicyStorePrismaService;
    let app: INestApplication;
    let producer: LifecyclePollProducer;
    let identities: ExternalRequisitionIdentityRepository;
    let mappings: RequisitionLifecycleMappingRepository;
    let registry: LifecycleSourceAdapterRegistry;
    let fake: FakeFg;
    let savedEnv: Partial<Record<string, string | undefined>> = {};

    async function seedReq(tenant: string, status: string): Promise<string> {
      const id = uuid();
      await db.query(
        `WITH seq AS (
           INSERT INTO requisition."RequisitionNumberSequence" (tenant_id, next_value)
           VALUES ($2::uuid, 1000)
           ON CONFLICT (tenant_id) DO UPDATE SET next_value = requisition."RequisitionNumberSequence".next_value + 1
           RETURNING next_value
         )
         INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, status, requisition_number)
         SELECT $1,$2,$3,$4,$5::"requisition"."RecruitingStatus",(SELECT next_value FROM seq)`,
        [id, tenant, `r-${status}`, uuid(), status],
      );
      return id;
    }

    // Seed an ACTIVE fieldglass connection with the opaque secret_ref (unless
    // withSecret=false) + the non-secret connection config.
    async function seedConnection(tenant: string, withSecret = true): Promise<string> {
      const id = uuid();
      const secretRef = withSecret ? buildConnectorSecretRef({ tenant_id: tenant, connection_id: id }) : null;
      await db.query(
        `INSERT INTO integration."IntegrationConnection" (id, tenant_id, provider_key, status, secret_ref, config, updated_at)
         VALUES ($1,$2,'fieldglass','active',$3,$4::jsonb, now())`,
        [id, tenant, secretRef, JSON.stringify(FG_CONFIG)],
      );
      return id;
    }

    function pollConn(connId: string, cursor: string | null = null): ReturnType<LifecyclePollProducer['pollConnection']> {
      return producer.pollConnection({
        id: connId,
        tenant_id: TENANT,
        provider_key: 'fieldglass',
        cursor,
        config: FG_CONFIG,
      });
    }

    async function statusOf(id: string): Promise<{ status: string; version: number }> {
      return (await db.query(`SELECT status, version FROM requisition."Requisition" WHERE id=$1`, [id])).rows[0];
    }
    async function ledgerRows(connectionId: string, externalReqId: string): Promise<
      Array<{ observation_key: string; status: string; outcome: string | null; provider_event_at: Date | null; provider_sequence: string | null }>
    > {
      return (
        await db.query(
          `SELECT observation_key, status, outcome, provider_event_at, provider_sequence
             FROM integration."LifecycleObservationLedger"
             WHERE connection_id=$1 AND external_req_id=$2 ORDER BY created_at ASC`,
          [connectionId, externalReqId],
        )
      ).rows;
    }
    async function reconRow(connectionId: string, externalEventId: string): Promise<Record<string, unknown> | undefined> {
      return (
        await db.query(
          `SELECT * FROM integration."RequisitionExternalReconciliation" WHERE connection_id=$1 AND external_event_id=$2`,
          [connectionId, externalEventId],
        )
      ).rows[0];
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1,'ats') ON CONFLICT DO NOTHING`,
        [TENANT],
      );

      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      const store = new PolicyStore(storePrisma);
      await store.publish({ tenant_id: TENANT, definition: REQUISITION_LIFECYCLE_PACKAGE, published_by: SYSTEM });

      const kp = await generateKeyPair('RS256');
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        ARAMO_ENV: process.env['ARAMO_ENV'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-cbd2fg-spec';
      process.env['AUTH_PUBLIC_KEY'] = pem;
      process.env['ARAMO_ENV'] = 'test'; // required by deriveConnectorSecretManagerId

      // A fake Secrets Manager returns the encoded FG credential bundle for any
      // server-derived secret id (the resolver derives it from the connection's
      // own tenant/id; the test connections all share one set of test creds).
      const fakeSecrets: SecretsManagerPort = {
        getSecretValue: async () => encodeFieldglassCredential(FG_BUNDLE),
      };

      const mod: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SECRETS_MANAGER_PORT)
        .useValue(fakeSecrets)
        .compile();
      app = mod.createNestApplication();
      await app.init();
      producer = app.get(LifecyclePollProducer);
      identities = app.get(ExternalRequisitionIdentityRepository);
      mappings = app.get(RequisitionLifecycleMappingRepository);
      registry = app.get(LifecycleSourceAdapterRegistry);

      fake = { tokenCalls: [], downloadCalls: [], downloadBody: '', contentType: 'application/json' };
      installFakeFg(fake);
    }, 120_000);

    afterEach(() => {
      fake.tokenCalls = [];
      fake.downloadCalls = [];
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await app?.close();
      await storePrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }, 60_000);

    it('proof 1 — PARSE+OBSERVE: the REAL adapter parses the documented OAGIS shape; raw <Status> passthrough; nulls per state-observation', async () => {
      const adapter = registry.resolve('fieldglass');
      expect(adapter).not.toBeNull();
      expect(adapter?.providerKey).toBe('fieldglass');

      // Drive the REAL FieldglassLifecycleSource directly with the XML documented shape.
      fake.downloadBody = xmlDownload('FG-DL-PARSE', [{ idValue: 'VMS-P1', status: 'Halted' }]);
      fake.contentType = 'application/xml';
      const ctx: LifecycleFetchContext & { config: Record<string, unknown> } = {
        tenant_id: TENANT,
        connection_id: uuid(),
        provider_key: 'fieldglass',
        cursor: null,
        credential: encodeFieldglassCredential(FG_BUNDLE),
        config: FG_CONFIG,
      };
      const result = await adapter!.fetchLifecycleChanges(ctx);

      expect(result.changes).toHaveLength(1);
      const change = result.changes[0]!;
      expect(change.kind).toBe('observation'); // NEVER an event
      expect(change.external_req_id).toBe('VMS-P1'); // IdValue -> external_req_id
      expect(change.observed_status).toBe('Halted'); // raw SAP status, VERBATIM (no map)
      expect(change.provider_event_at).toBeNull(); // no fabricated event timestamp
      expect(change.provider_sequence).toBeNull(); // no fabricated sequence
      expect(change.ordering_confidence).toBe('unknown'); // a state pull is never causal proof
      expect(typeof result.delivery.delivery_id).toBe('string');
      expect(result.delivery.delivery_id.length).toBeGreaterThan(0);
      expect(result.next_cursor).not.toBe(null); // an opaque advanced watermark

      // The token endpoint was called with the resolved OAuth client credentials.
      expect(fake.tokenCalls).toHaveLength(1);
      expect(fake.tokenCalls[0]?.body).toContain('grant_type=client_credentials');
      expect(fake.tokenCalls[0]?.body).toContain('fg-client-abc');
      // The JSON path parses equivalently.
      fake.downloadBody = jsonDownload('FG-DL-PARSE-J', [{ idValue: 'VMS-PJ', status: 'Closed' }]);
      fake.contentType = 'application/json';
      const jsonResult = await adapter!.fetchLifecycleChanges({ ...ctx, connection_id: uuid() });
      expect(jsonResult.changes[0]?.observed_status).toBe('Closed');
      expect(jsonResult.changes[0]?.external_req_id).toBe('VMS-PJ');
    });

    it('proof 2 — GOVERNED EXECUTE: Halted->PUT_ON_HOLD, Closed->CLOSE, Withdrawn->CANCEL, Submitted->REOPEN (open->target via L1-D1 seam)', async () => {
      // Halted -> PUT_ON_HOLD (open -> on_hold)
      const held = await seedReq(TENANT, 'open');
      const heldConn = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: heldConn, provider_state: 'halted', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: heldConn, external_req_id: 'REQ-HALT', requisition_id: held });
      expect((await statusOf(held)).status).toBe('open'); // BEFORE
      fake.downloadBody = jsonDownload('DL-HALT', [{ idValue: 'REQ-HALT', status: 'Halted' }]);
      fake.contentType = 'application/json';
      await pollConn(heldConn);
      expect((await statusOf(held)).status).toBe('on_hold'); // AFTER

      // Closed -> CLOSE (open -> closed)
      const closedReq = await seedReq(TENANT, 'open');
      const closedConn = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: closedConn, provider_state: 'closed', mapped_action: 'CLOSE', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: closedConn, external_req_id: 'REQ-CLOSE', requisition_id: closedReq });
      fake.downloadBody = jsonDownload('DL-CLOSE', [{ idValue: 'REQ-CLOSE', status: 'Closed' }]);
      await pollConn(closedConn);
      expect((await statusOf(closedReq)).status).toBe('closed');

      // Withdrawn -> CANCEL (open -> canceled)
      const cancelReq = await seedReq(TENANT, 'open');
      const cancelConn = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: cancelConn, provider_state: 'withdrawn', mapped_action: 'CANCEL', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: cancelConn, external_req_id: 'REQ-WD', requisition_id: cancelReq });
      fake.downloadBody = jsonDownload('DL-WD', [{ idValue: 'REQ-WD', status: 'Withdrawn' }]);
      await pollConn(cancelConn);
      expect((await statusOf(cancelReq)).status).toBe('canceled');

      // Submitted -> REOPEN (closed -> open; REOPEN is ALLOW from closed)
      const reopenReq = await seedReq(TENANT, 'closed');
      const reopenConn = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: reopenConn, provider_state: 'submitted', mapped_action: 'REOPEN', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: reopenConn, external_req_id: 'REQ-RO', requisition_id: reopenReq });
      expect((await statusOf(reopenReq)).status).toBe('closed'); // BEFORE
      fake.downloadBody = jsonDownload('DL-RO', [{ idValue: 'REQ-RO', status: 'Submitted' }]);
      await pollConn(reopenConn);
      expect((await statusOf(reopenReq)).status).toBe('open'); // AFTER
    });

    it('proof 3 — UNMAPPABLE: a status with no per-connection mapping -> reconciliation, no mutation', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT); // NO mapping seeded
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'REQ-UNMAP', requisition_id: reqId });
      fake.downloadBody = jsonDownload('DL-UNMAP', [{ idValue: 'REQ-UNMAP', status: 'Rejected' }]);
      fake.contentType = 'application/json';

      await pollConn(connId);

      expect((await statusOf(reqId)).status).toBe('open'); // unchanged
      const rows = await ledgerRows(connId, 'REQ-UNMAP');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('reconciled');
      expect((await reconRow(connId, 'DL-UNMAP:REQ-UNMAP'))?.['failure_reason']).toBe('UNMAPPABLE_PROVIDER_STATE');
    });

    it('proof 4 — UNRESOLVED IDENTITY: no ExternalRequisitionIdentity -> reconciliation (REQUISITION_NOT_FOUND), never opportunistic creation', async () => {
      const connId = await seedConnection(TENANT); // NO identity established
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'halted', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      const reqCountBefore = (await db.query(`SELECT count(*)::int AS c FROM requisition."Requisition" WHERE tenant_id=$1`, [TENANT])).rows[0].c;

      fake.downloadBody = jsonDownload('DL-NOID', [{ idValue: 'REQ-GHOST', status: 'Halted' }]);
      await pollConn(connId);

      const rows = await ledgerRows(connId, 'REQ-GHOST');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('reconciled');
      expect((await reconRow(connId, 'DL-NOID:REQ-GHOST'))?.['failure_reason']).toBe('REQUISITION_NOT_FOUND');
      // No requisition was invented (CREATE authority is NOT collapsed into lifecycle).
      const reqCountAfter = (await db.query(`SELECT count(*)::int AS c FROM requisition."Requisition" WHERE tenant_id=$1`, [TENANT])).rows[0].c;
      expect(reqCountAfter).toBe(reqCountBefore);
    });

    it('proof 5 — IDEMPOTENCY: re-polling the SAME delivery dedups; a NEW delivery re-observing the same status is NOT collapsed', async () => {
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'halted', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'REQ-IDEM', requisition_id: reqId });

      // First poll — delivery DL-IDEM-1 executes.
      fake.downloadBody = jsonDownload('DL-IDEM-1', [{ idValue: 'REQ-IDEM', status: 'Halted' }]);
      await pollConn(connId);
      expect((await statusOf(reqId)).status).toBe('on_hold');
      expect((await statusOf(reqId)).version).toBe(1);
      expect(await ledgerRows(connId, 'REQ-IDEM')).toHaveLength(1);

      // Re-poll the SAME delivery (same DownloadId) -> dedup, NO double-apply.
      await pollConn(connId);
      expect((await statusOf(reqId)).version).toBe(1); // not double-incremented
      expect(await ledgerRows(connId, 'REQ-IDEM')).toHaveLength(1); // still ONE row for DL-IDEM-1

      // A NEW delivery (new DownloadId) re-observing the same status -> NEW ledger
      // row (not collapsed); already-on_hold so it routes to reconciliation.
      fake.downloadBody = jsonDownload('DL-IDEM-2', [{ idValue: 'REQ-IDEM', status: 'Halted' }]);
      await pollConn(connId);
      expect(await ledgerRows(connId, 'REQ-IDEM')).toHaveLength(2); // DL-IDEM-1 + DL-IDEM-2
    });

    it('proof 6 — CREDENTIAL: the producer resolves secret_ref; the fake OAuth used it; a NULL secret_ref -> CONNECTOR_SECRET_UNAVAILABLE, NO provider call', async () => {
      // WITH secret_ref: the producer resolves it and the adapter uses the client creds.
      const reqId = await seedReq(TENANT, 'open');
      const connId = await seedConnection(TENANT, true);
      await mappings.upsertMapping({ tenant_id: TENANT, connection_id: connId, provider_state: 'halted', mapped_action: 'PUT_ON_HOLD', authority_mode: 'external_authority' });
      await identities.record({ tenant_id: TENANT, connection_id: connId, external_req_id: 'REQ-CRED', requisition_id: reqId });
      fake.downloadBody = jsonDownload('DL-CRED', [{ idValue: 'REQ-CRED', status: 'Halted' }]);
      await pollConn(connId);
      expect((await statusOf(reqId)).status).toBe('on_hold');
      expect(fake.tokenCalls).toHaveLength(1);
      // The resolved OAuth client credential material rode into the token POST body.
      expect(fake.tokenCalls[0]?.body).toContain('fg-client-abc');
      expect(fake.tokenCalls[0]?.body).toContain('fg-secret-xyz');

      // NULL secret_ref: the producer resolves CONNECTOR_SECRET_UNAVAILABLE and the
      // adapter refuses BEFORE any provider call.
      fake.tokenCalls = [];
      fake.downloadCalls = [];
      const noSecretConn = await seedConnection(TENANT, false);
      await expect(pollConn(noSecretConn)).rejects.toThrow(/CONNECTOR_SECRET_UNAVAILABLE/);
      expect(fake.tokenCalls).toHaveLength(0); // NO OAuth call
      expect(fake.downloadCalls).toHaveLength(0); // NO download call
    });

    it('proof 7 — STATE-OBSERVATION boundary: every emitted change is kind:observation with a null provider_event_at (never an event)', async () => {
      const adapter = registry.resolve('fieldglass')!;
      fake.downloadBody = jsonDownload('DL-BND', [
        { idValue: 'REQ-B1', status: 'Halted' },
        { idValue: 'REQ-B2', status: 'Closed' },
        { idValue: 'REQ-B3', status: 'Submitted' },
      ]);
      fake.contentType = 'application/json';
      const result = await adapter.fetchLifecycleChanges({
        tenant_id: TENANT,
        connection_id: uuid(),
        provider_key: 'fieldglass',
        cursor: null,
        credential: encodeFieldglassCredential(FG_BUNDLE),
        config: FG_CONFIG,
      } as LifecycleFetchContext);
      expect(result.changes).toHaveLength(3);
      for (const change of result.changes) {
        expect(change.kind).toBe('observation'); // NEVER 'event'
        expect(change.provider_event_at).toBeNull(); // NEVER a provider event timestamp
        expect(change.provider_sequence).toBeNull();
        expect(change.ordering_confidence).toBe('unknown');
      }
    });

    it('proof 8 — HARD-PROHIBITION (structural): the FG adapter provider directory writes NO requisition state', () => {
      const dir = resolve(ROOT, 'libs/integration/src/lib/lifecycle/provider/fieldglass');
      const files: string[] = [];
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const p = resolve(d, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (name.endsWith('.ts')) files.push(p);
        }
      };
      walk(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        expect(content, `${file}: prisma requisition write`).not.toMatch(/\.requisition\.(update|updateMany|create|upsert)\s*\(/i);
        expect(content, `${file}: raw UPDATE requisition.Requisition`).not.toMatch(/UPDATE\s+["'`]?requisition["'`]?\s*\.\s*["'`]?Requisition/i);
        expect(content, `${file}: executeExternalLifecycleCommand`).not.toMatch(/executeExternalLifecycleCommand/);
      }
    });
  },
);
