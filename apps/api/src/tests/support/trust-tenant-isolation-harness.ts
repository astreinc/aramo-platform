import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import { TalentTrustRepository, TalentTrustService, type SubjectRef } from '@aramo/talent-trust';
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../../app.module.js';
import { ensureWriteFreezeTenant } from '../write-freeze-tenant.js';

import { ConfigurableTestResolver } from './test-auth-harness.js';

// Security S1 — the ONE shared fixture for the Talent Trust tenant-isolation
// regression suite (directive §5). Real Postgres (Testcontainers) with the FULL
// migration set in timestamp order (policy_store included — the reproduction's
// non-fatal TenantPolicyCoverageGuard warning came from a partial set), the real
// AppModule over HTTP, and two ACTIVE tenants entitled to `core` + `ats`.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../../..');
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-security-s1a-spec';

function allMigrations(): string[] {
  const libs = resolve(ROOT, 'libs');
  const out: Array<{ ts: string; path: string }> = [];
  for (const lib of readdirSync(libs)) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(libs, lib, 'prisma', 'migrations'));
    } catch {
      continue;
    }
    for (const d of entries) {
      const file = resolve(libs, lib, 'prisma', 'migrations', d, 'migration.sql');
      try {
        readFileSync(file);
      } catch {
        continue;
      }
      out.push({ ts: d, path: file });
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out.map((o) => o.path);
}

export interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

// The foreign-mutation evidence for one EvidenceRecord: status, its event and
// link counts, and the owning subject's whole TrustState row (byte-compared).
export interface EvidenceSnapshot {
  current_status: string;
  events: number;
  links: number;
  trust_state: string;
}

export interface TrustTenantHarness {
  db: Client;
  trust: TalentTrustService;
  repo: TalentTrustRepository;
  module: TestingModule;
  jwtFor(tenantId: string, userId: string, scopes: string[]): Promise<string>;
  post(path: string, jwt: string, body: unknown): Promise<HttpResult>;
  get(path: string, jwt: string): Promise<HttpResult>;
  refFor(tenantId: string, talentId: string): SubjectRef;
  seedEvidence(tenantId: string, talentId: string): Promise<string>;
  snapshot(evidenceId: string): Promise<EvidenceSnapshot>;
  close(): Promise<void>;
}

export async function startTrustTenantHarness(tenants: readonly string[]): Promise<TrustTenantHarness> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
  const url = container.getConnectionUri();
  const db = new Client({ connectionString: url });
  await db.connect();
  for (const p of allMigrations()) await db.query(readFileSync(p, 'utf8'));
  for (const t of tenants) {
    await ensureWriteFreezeTenant((sql) => db.query(sql), t, 'ACTIVE');
    for (const cap of ['core', 'ats']) {
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`,
        [t, cap],
      );
    }
  }

  const resolver = new ConfigurableTestResolver();
  const kp = await generateKeyPair('RS256');
  const privateKey = kp.privateKey as SignKey;
  const saved: Record<string, string | undefined> = {};
  for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'MAILER_PROVIDER']) saved[k] = process.env[k];
  process.env['DATABASE_URL'] = url;
  process.env['AUTH_AUDIENCE'] = AUDIENCE;
  process.env['AUTH_PUBLIC_KEY'] = await exportSPKI(kp.publicKey as never);
  process.env['MAILER_PROVIDER'] = 'stub';

  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
    .useValue(resolver)
    .compile();
  const app: INestApplication = module.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  const port = ((await app.listen(0)).address() as AddressInfo).port;
  const trust = module.get(TalentTrustService);
  const repo = module.get(TalentTrustRepository);

  const call = async (method: 'GET' | 'POST', path: string, jwt: string, body?: unknown): Promise<HttpResult> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const refFor = (tenantId: string, talentId: string): SubjectRef => ({
    tenant_id: tenantId,
    ref_type: 'ATS_TALENT_RECORD',
    ref_id: talentId,
  });

  return {
    db,
    trust,
    repo,
    module,
    jwtFor: (tenantId, userId, scopes) =>
      new SignJWT({
        sub: userId,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenantId,
        authz_version: resolver.grant(tenantId, userId, scopes),
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey),
    post: (path, jwt, body) => call('POST', path, jwt, body),
    get: (path, jwt) => call('GET', path, jwt),
    refFor,
    // A VALID, authoritative CLAIMS record with a recomputed TrustState.
    async seedEvidence(tenantId, talentId) {
      const ev = await trust.recordEvidence({
        subjectRef: refFor(tenantId, talentId),
        dimension: 'CLAIMS',
        assertion_type: 'CERTIFICATION',
        assertion_payload: { name_raw: 'CKA' },
        source_class: 'AUTHORITATIVE_ISSUER',
        method: 'API_REGISTRY',
        source_ref: { talent_evidence_id: talentId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'security-s1a-spec',
      });
      return ev.id;
    },
    async snapshot(evidenceId) {
      const row = (
        await db.query<{ current_status: string; subject_id: string }>(
          `SELECT current_status, subject_id FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`,
          [evidenceId],
        )
      ).rows[0]!;
      const n = async (sql: string): Promise<number> =>
        Number((await db.query<{ n: number }>(sql, [evidenceId])).rows[0]!.n);
      const ts = await db.query(`SELECT * FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`, [row.subject_id]);
      return {
        current_status: row.current_status,
        events: await n(`SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid`),
        links: await n(
          `SELECT count(*)::int AS n FROM talent_trust."EvidenceLink" WHERE from_evidence_id = $1::uuid OR to_evidence_id = $1::uuid`,
        ),
        trust_state: JSON.stringify(ts.rows),
      };
    },
    async close() {
      await app.close();
      await db.end();
      await container.stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
