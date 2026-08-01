import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { Logger } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PolicyStore,
  PrismaService as PolicyStorePrismaService,
  type PublishPolicyVersionInput,
} from '@aramo/policy-store';

// ADR-0024 PR-4d — the active-version cache TTL. Real Postgres 17; skipped
// unless ARAMO_RUN_INTEGRATION=1. Two SEPARATE PolicyStore instances share one
// DB (a reader + another connection that publishes) — the multi-process shape
// the defect lives in.
//
// The past-TTL test is the DEFECT-FIX proof: against the current invalidate-only
// cache it FAILS (the reader serves the stale version forever); with the TTL it
// re-reads and picks up the other connection's publish.

const ROOT = resolve(__dirname, '../../../..');
const TENANT = '01900000-0000-7000-8000-0000000000fa';
const PKG = 'requisition-lifecycle';
const SYSTEM = '00000000-0000-0000-0000-000000000000';
const TTL_MS = 200;

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = migrationsFor('policy-store');

function pkg(version: string): PublishPolicyVersionInput['definition'] {
  return {
    name: PKG, version,
    registry: { resources: ['REQUISITION_TALENT'], actions: ['ADD'] },
    default_disposition: { decision: 'ALLOW', reason_code: 'X' },
    rules: [],
  };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PR-4d PolicyStore cache TTL (real Postgres 17, two connections)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let readerPrisma: PolicyStorePrismaService;
    let publisherPrisma: PolicyStorePrismaService;
    let reader: PolicyStore; // the "running api" instance
    let publisher: PolicyStore; // "another connection / instance"
    let savedTtl: string | undefined;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));

      // A short TTL for the test (env-overridable, per the ruling). Set BEFORE
      // the stores are constructed so each reads it.
      savedTtl = process.env['ARAMO_POLICY_CACHE_TTL_MS'];
      process.env['ARAMO_POLICY_CACHE_TTL_MS'] = String(TTL_MS);

      readerPrisma = new PolicyStorePrismaService(url);
      publisherPrisma = new PolicyStorePrismaService(url);
      await readerPrisma.$connect();
      await publisherPrisma.$connect();
      reader = new PolicyStore(readerPrisma);
      publisher = new PolicyStore(publisherPrisma);

      // v1.0.0 published (from 2026-01-01), and the reader caches it.
      await publisher.publish({ tenant_id: TENANT, definition: pkg('1.0.0'), published_by: SYSTEM, effective_from: new Date('2026-01-01T00:00:00Z') });
    }, 120_000);

    afterAll(async () => {
      await readerPrisma?.onModuleDestroy();
      await publisherPrisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
      if (savedTtl === undefined) delete process.env['ARAMO_POLICY_CACHE_TTL_MS'];
      else process.env['ARAMO_POLICY_CACHE_TTL_MS'] = savedTtl;
    }, 60_000);

    afterEach(() => vi.restoreAllMocks());

    it('within TTL — the reader serves the cached version (no re-read) even after another connection publishes a newer one', async () => {
      expect((await reader.getActiveVersion(TENANT, PKG))?.version).toBe('1.0.0'); // caches v1
      // Another connection publishes v2.0.0 (later window).
      await publisher.publish({ tenant_id: TENANT, definition: pkg('2.0.0'), published_by: SYSTEM, effective_from: new Date('2026-02-01T00:00:00Z') });
      // Immediately (within TTL) the reader still serves the cached v1.0.0.
      expect((await reader.getActiveVersion(TENANT, PKG))?.version).toBe('1.0.0');
    });

    it('PAST TTL — the reader re-reads and picks up the version published by the OTHER connection (defect fixed)', async () => {
      await sleep(TTL_MS + 120); // let the cached entry age past the TTL
      expect((await reader.getActiveVersion(TENANT, PKG))?.version).toBe('2.0.0');
    });

    it('publish on the SAME instance is immediate — eviction preserved, no TTL wait', async () => {
      expect((await reader.getActiveVersion(TENANT, PKG))?.version).toBe('2.0.0'); // caches v2
      await reader.publish({ tenant_id: TENANT, definition: pkg('3.0.0'), published_by: SYSTEM, effective_from: new Date('2026-03-01T00:00:00Z') });
      // No sleep — the publishing instance evicted its own key.
      expect((await reader.getActiveVersion(TENANT, PKG))?.version).toBe('3.0.0');
    });

    it('the cache-load log line names tenant, package, version, and checksum (INFO, no DB query to inspect)', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      await sleep(TTL_MS + 120); // force a re-read → a cache load → a log
      const active = await reader.getActiveVersion(TENANT, PKG);
      const logged = logSpy.mock.calls.map((c) => JSON.stringify(c[0])).join(' | ');
      expect(logged).toContain(TENANT);
      expect(logged).toContain(PKG);
      expect(logged).toContain(active!.version);
      expect(logged).toContain(active!.checksum);
    });
  },
);
