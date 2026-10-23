import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';
import { Verifier } from '@pact-foundation/pact';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { INTELLIGENCE_SCOPES } from '@aramo/intelligence-contracts';
import {
  IntelligencePrismaService,
  PrismaIntelligenceUnitOfWork,
  VerificationCodeService,
  provisionServiceClient,
} from '@aramo/intelligence-core';
import { AppModule } from '@aramo/talent-intelligence-service';

// ATI-SEP-1 §5 — Pact provider verifier for apps/talent-intelligence-service.
//
// Consumer:  intelligence-integration     (libs/intelligence-integration IntelligenceClient)
// Provider:  talent-intelligence-service  (apps/talent-intelligence-service)
//
// A SEPARATE provider (mirrors verify-sign.ts): boots the TI AppModule against a
// Postgres 17 testcontainer holding the TI database (aramo_intelligence) with
// every libs/intelligence-core migration applied whole-file in timestamp order
// (the tools/db-sync-intelligence.sh order), then verifies the recorded pact.
// Provider states seed through the service's OWN HTTP surface (entitlement sync,
// ingestion, verification, disputes) with a real service token, so the seeded
// rows are exactly what production writes. The consumer sends a placeholder
// bearer; the requestFilter swaps in a freshly minted real token.
//
// Gated on ARAMO_RUN_PACT_PROVIDER=1 (same as verify.ts / verify-api.ts / verify-sign.ts).

const ROOT = resolve(__dirname, '../../..');
const PACT_FILE = resolve(ROOT, 'pact/pacts/intelligence-integration-talent-intelligence-service.json');

function intelligenceMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/intelligence-core/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

// MUST match pact/consumers/intelligence-integration-consumer/src/intelligence-client.consumer.test.ts.
const CLIENT_ID = 'pact-ats';
const CLIENT_SECRET = 'pact-intelligence-integration-client-secret-0001';
const SYS = 'ARAMO_ATS';
const VERIFICATION_CODE_KEY = 'pact-verification-code-key-0123456789abcdef';
const SEED_AT = '2026-10-20T10:00:00.000Z';
const VERIFIED = { status: 'VERIFIED', method: 'EMAIL_OTP', source: 'ARAMO_PORTAL', verified_at: '2026-10-01T00:00:00.000Z' };

interface StateParams {
  tenant_id: string;
  talent_id: string;
}

function stateParams(params: unknown): StateParams {
  const p = (params ?? {}) as Record<string, unknown>;
  const tenant = p['tenant_id'];
  const talent = p['talent_id'];
  if (typeof tenant !== 'string' || typeof talent !== 'string') throw new Error('provider state needs { tenant_id, talent_id }');
  return { tenant_id: tenant, talent_id: talent };
}

describe.skipIf(process.env['ARAMO_RUN_PACT_PROVIDER'] !== '1')(
  'pact provider verification — talent-intelligence-service (apps/talent-intelligence-service)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let module: TestingModule;
    let app: NestExpressApplication;
    let baseUrl = '';
    let token = '';
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    const seeded = new Set<string>();
    const entitled = new Set<string>();

    async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<{ status: number; body: T }> {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (auth) headers['authorization'] = `Bearer ${token}`;
      const res = await fetch(`${baseUrl}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: (text.length > 0 ? JSON.parse(text) : null) as T };
    }

    async function expectOk<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
      const res = await call<T>(method, path, body);
      if (res.status < 200 || res.status >= 300) throw new Error(`seed ${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    }

    async function mintToken(): Promise<void> {
      const res = await call<{ access_token: string }>(
        'POST',
        '/v1/oauth/token',
        { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
        false,
      );
      if (res.status !== 200) throw new Error(`token exchange → ${res.status} ${JSON.stringify(res.body)}`);
      token = res.body.access_token;
    }

    async function entitle(tenant: string): Promise<void> {
      if (entitled.has(tenant)) return;
      await expectOk('POST', '/v1/entitlements/sync', { source_system_id: SYS, mode: 'UPSERT', tenants: [{ tenant_id: tenant, active: true }] });
      entitled.add(tenant);
    }

    /** One full snapshot of (tenant, talent): a name, one email, a SKILL and a TITLE. Idempotent per reference. */
    async function ingest(
      tenant: string,
      talent: string,
      opts: { email?: string; verified?: boolean; title?: string; observedAt?: string } = {},
    ): Promise<void> {
      const key = `${tenant}/${talent}`;
      if (seeded.has(key)) return;
      const at = opts.observedAt ?? SEED_AT;
      const email = { value: opts.email ?? `${talent}@pact.example.com`, is_primary: true, ...(opts.verified === true ? { verification: VERIFIED } : {}) };
      await expectOk('POST', '/v1/ingest/talent', {
        source_system_id: SYS,
        source_tenant_id: tenant,
        external_talent_id: talent,
        source_event_id: randomUUID(),
        occurred_at: at,
        identity: { names: { first: 'Priya', last: 'Raman' }, emails: [email] },
        assertions: [
          { assertion_type: 'SKILL', payload: { name: 'TypeScript', years: 5 }, source_kind: 'RECRUITER', observed_at: at },
          { assertion_type: 'TITLE', payload: { value: opts.title ?? 'Staff Engineer' }, source_kind: 'RECRUITER', observed_at: at },
        ],
      });
      seeded.add(key);
    }

    interface EvidenceItem {
      assertion_id: string;
      assertion_type: string;
      status: string;
      contributed_by: string;
    }

    async function titleAssertion(tenant: string, talent: string, status?: string): Promise<string> {
      const ev = await expectOk<{ assertions: EvidenceItem[] }>('GET', `/v1/references/${SYS}/${tenant}/${talent}/evidence`);
      const hit = ev.assertions.find(
        (a) => a.assertion_type === 'TITLE' && a.contributed_by === 'REQUESTING_TENANT' && (status === undefined || a.status === status),
      );
      if (hit === undefined) throw new Error(`no TITLE assertion${status !== undefined ? ` in ${status}` : ''} on ${tenant}/${talent}: ${JSON.stringify(ev.assertions)}`);
      return hit.assertion_id;
    }

    async function openProposal(tenant: string): Promise<string> {
      const list = await expectOk<{ items: Array<{ proposal_id: string }> }>('GET', `/v1/tenants/${tenant}/proposals?kind=VERIFY_CONTACT`);
      const first = list.items[0];
      if (first === undefined) throw new Error(`no open VERIFY_CONTACT proposal for tenant ${tenant}`);
      return first.proposal_id;
    }

    async function openDispute(tenant: string, talent: string): Promise<string> {
      const assertionId = await titleAssertion(tenant, talent);
      const opened = await expectOk<{ dispute_id: string }>('POST', '/v1/disputes', {
        portal_context: { source_system_id: SYS, source_tenant_id: tenant, external_talent_id: talent },
        assertion_id: assertionId,
        statement: 'This title is not mine.',
      });
      return opened.dispute_id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').withDatabase('aramo_intelligence').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      // Whole-file, in order — the TI migrations carry $$-quoted trigger bodies.
      for (const f of intelligenceMigrations()) await db.query(readFileSync(f, 'utf8'));

      const env: Record<string, string | undefined> = {
        INTELLIGENCE_DATABASE_URL: url,
        INTELLIGENCE_SERVICE_TOKEN_SECRET: 'pact-ti-service-token-secret-0123456789abcdef',
        INTELLIGENCE_GOV_ID_TOKEN_KEY: 'pact-ti-gov-id-token-key-0123456789abcdef',
        INTELLIGENCE_VERIFICATION_CODE_KEY: VERIFICATION_CODE_KEY,
        TI_OUTBOX_DRAIN_ENABLED: '0',
        TI_REASSESSMENT_ENABLED: '0',
        TI_CROSS_TENANT_READ_ENABLED: 'false',
        DATABASE_URL: undefined,
      };
      for (const [k, v] of Object.entries(env)) {
        savedEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }

      // The ATS ServiceClient the consumer authenticates as — every intelligence scope.
      const provisioning = new IntelligencePrismaService(url);
      try {
        await provisionServiceClient(new PrismaIntelligenceUnitOfWork(provisioning), {
          client_id: CLIENT_ID,
          source_system_id: SYS,
          scopes: [...INTELLIGENCE_SCOPES],
          secret: CLIENT_SECRET,
        });
      } finally {
        await provisioning.$disconnect();
      }

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
      // Mirror apps/talent-intelligence-service/src/main.ts.
      app.useBodyParser('json', { limit: '1mb' });
      app.useBodyParser('urlencoded', { extended: false, limit: '16kb' });
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await mintToken();
    }, 600_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 120_000);

    it('verifies the intelligence-integration → talent-intelligence-service pact', async () => {
      const codes = VerificationCodeService.withKey(VERIFICATION_CODE_KEY);
      const verifier = new Verifier({
        provider: 'talent-intelligence-service',
        providerBaseUrl: baseUrl,
        pactUrls: [PACT_FILE],
        logLevel: 'warn',
        // The consumer's placeholder bearer → a real service token (the token
        // exchange interaction carries no Authorization header and passes untouched).
        requestFilter: (req, _res, next) => {
          if (typeof req.headers['authorization'] === 'string') req.headers['authorization'] = `Bearer ${token}`;
          next();
        },
        stateHandlers: {
          'the ATS service client is provisioned': async () => {
            await mintToken();
            return undefined;
          },
          'no reference exists for the talent': async (params?: unknown) => {
            stateParams(params);
            await mintToken();
            return undefined;
          },
          'a reference exists for the talent': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            await ingest(p.tenant_id, p.talent_id);
            return undefined;
          },
          'an entitled tenant holds a reference with evidence': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            await ingest(p.tenant_id, p.talent_id);
            return undefined;
          },
          'a tenant without the intelligence entitlement holds a reference': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await ingest(p.tenant_id, p.talent_id);
            return undefined;
          },
          'an entitled tenant without the reference': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            return undefined;
          },
          'a pending email verification exists': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            await ingest(p.tenant_id, p.talent_id);
            const created = await expectOk<{ verification_id: string }>('POST', '/v1/verifications', {
              source_reference: { source_system_id: SYS, source_tenant_id: p.tenant_id, external_talent_id: p.talent_id },
              identifier_type: 'EMAIL',
              value: `${p.talent_id}@pact.example.com`,
            });
            const row = await db.query<{ code_salt: string }>(`SELECT code_salt FROM "intelligence"."VerificationRequest" WHERE id = $1`, [created.verification_id]);
            const salt = row.rows[0]?.code_salt;
            if (salt === undefined) throw new Error(`verification ${created.verification_id} not persisted`);
            return { verificationId: created.verification_id, code: codes.codeFor(created.verification_id, salt) };
          },
          'a reference with a verified email exists': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            await ingest(p.tenant_id, p.talent_id, { verified: true });
            return undefined;
          },
          'an open verify-contact proposal exists': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            await ingest(p.tenant_id, p.talent_id);
            return { proposalId: await openProposal(p.tenant_id) };
          },
          // Two references of the SAME tenant on one subject (shared verified email
          // anchor) asserting different titles → each TITLE is CONTRADICTED.
          'a contradicted assertion exists on the reference': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            const email = `${p.talent_id}@pact.example.com`;
            await ingest(p.tenant_id, p.talent_id, { email, verified: true, title: 'Staff Engineer', observedAt: '2026-10-01T00:00:00.000Z' });
            await ingest(p.tenant_id, `${p.talent_id}-b`, { email, verified: true, title: 'Engineering Manager', observedAt: '2026-10-05T00:00:00.000Z' });
            return { assertionId: await titleAssertion(p.tenant_id, p.talent_id, 'CONTRADICTED') };
          },
          'a disputable assertion exists on the reference': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            await ingest(p.tenant_id, p.talent_id);
            return { assertionId: await titleAssertion(p.tenant_id, p.talent_id) };
          },
          'an open dispute exists': async (params?: unknown) => {
            const p = stateParams(params);
            await mintToken();
            await entitle(p.tenant_id);
            await ingest(p.tenant_id, p.talent_id);
            return { disputeId: await openDispute(p.tenant_id, p.talent_id) };
          },
        },
      });
      await verifier.verifyProvider();
    }, 600_000);
  },
);
