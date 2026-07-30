import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { PolicyPackage } from '@aramo/policy-engine';

import { PolicyStore } from '../lib/policy-store.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PolicyStoreError } from '../lib/errors.js';

// PR-2 integration test (ADR-0024 §D7/§D17b). Brings up a Postgres
// testcontainer, applies the init migration, and proves:
//
//   - point-in-time retrieval across window boundaries (from inclusive, to
//     exclusive), including before-first and open-ended tail;
//   - checksum integrity — a row tampered directly in Postgres is detected;
//   - publication immutability — a published version cannot be re-published;
//     a change is a NEW version, and the prior version survives unchanged;
//   - tenant resolution — retrieval returns only the asking tenant's rows;
//   - cache correctness — a repeat current read is served from cache, and a
//     publication makes the next current read return the new version (no
//     stale read).

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260730120000_init_policy_store/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const PUBLISHER = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

// Fixed window instants for the point-in-time assertions.
const BEFORE = new Date('2025-01-01T00:00:00.000Z');
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T10 = new Date('2026-06-01T00:00:00.000Z');
const AFTER = new Date('2027-01-01T00:00:00.000Z');

// Domain-neutral identifiers (DOC/READ/WRITE) — the store carries no
// business vocabulary.
function makePackage(name: string, version: string, decision: 'ALLOW' | 'DENY' = 'DENY'): PolicyPackage {
  return {
    name,
    version,
    registry: { resources: ['DOC'], actions: ['READ', 'WRITE'] },
    default_disposition: { decision: 'ALLOW', reason_code: 'DEFAULT_ALLOW' },
    rules: [{ id: 'r1', resource: 'DOC', action: 'WRITE', decision, reason_code: 'RULE_1' }],
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PolicyStore — persistence/versioning integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let store: PolicyStore;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

      const setup = new PrismaService(url);
      await setup.$connect();
      for (const stmt of migrationSql.split(';')) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setup.$executeRawUnsafe(trimmed);
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "policy_store"."StoredPolicyVersion"');
      // Fresh store per test => fresh cache.
      store = new PolicyStore(prisma);
    });

    it('retrieves the version active at a point in time, across the boundary', async () => {
      await store.publish({ tenant_id: TENANT_A, definition: makePackage('doc', '1.0.0'), published_by: PUBLISHER, effective_from: T0 });
      await store.publish({ tenant_id: TENANT_A, definition: makePackage('doc', '1.1.0'), published_by: PUBLISHER, effective_from: T10 });

      // Before the first window → nothing active.
      expect(await store.getActiveVersion(TENANT_A, 'doc', BEFORE)).toBeNull();
      // At v1.effective_from (inclusive) and just inside → v1.
      expect((await store.getActiveVersion(TENANT_A, 'doc', T0))?.version).toBe('1.0.0');
      expect((await store.getActiveVersion(TENANT_A, 'doc', new Date(T10.getTime() - 1)))?.version).toBe('1.0.0');
      // At the shared boundary T10 → v2 (v1's to is exclusive, v2's from inclusive).
      expect((await store.getActiveVersion(TENANT_A, 'doc', T10))?.version).toBe('1.1.0');
      // Open-ended tail → v2.
      expect((await store.getActiveVersion(TENANT_A, 'doc', AFTER))?.version).toBe('1.1.0');
    });

    it('detects a definition tampered directly in the database', async () => {
      await store.publish({ tenant_id: TENANT_A, definition: makePackage('doc', '1.0.0'), published_by: PUBLISHER, effective_from: T0 });

      // Mutate the stored JSONB without recomputing the checksum column.
      await prisma.$executeRawUnsafe(
        `UPDATE "policy_store"."StoredPolicyVersion" SET definition = jsonb_set(definition, '{name}', '"tampered"') WHERE tenant_id = '${TENANT_A}' AND version = '1.0.0'`,
      );

      await expect(store.getVersion(TENANT_A, 'doc', '1.0.0')).rejects.toMatchObject({
        code: 'CHECKSUM_MISMATCH',
      });
      await expect(store.getActiveVersion(TENANT_A, 'doc', T0)).rejects.toBeInstanceOf(PolicyStoreError);
    });

    it('a published version is immutable; a change is a new version', async () => {
      const first = await store.publish({ tenant_id: TENANT_A, definition: makePackage('doc', '1.0.0'), published_by: PUBLISHER, effective_from: T0 });

      // Re-publishing the same version string is rejected.
      await expect(
        store.publish({ tenant_id: TENANT_A, definition: makePackage('doc', '1.0.0', 'ALLOW'), published_by: PUBLISHER, effective_from: T10 }),
      ).rejects.toMatchObject({ code: 'VERSION_ALREADY_EXISTS' });

      // The original row is untouched (same checksum, still readable).
      const stillThere = await store.getVersion(TENANT_A, 'doc', '1.0.0');
      expect(stillThere?.checksum).toBe(first.checksum);

      // A real change carries a new version → a new row; the old one survives.
      await store.publish({ tenant_id: TENANT_A, definition: makePackage('doc', '2.0.0', 'ALLOW'), published_by: PUBLISHER, effective_from: T10 });
      expect((await store.getActiveVersion(TENANT_A, 'doc', AFTER))?.version).toBe('2.0.0');
      const old = await store.getVersion(TENANT_A, 'doc', '1.0.0');
      expect(old).not.toBeNull();
      expect(old?.effective_to).not.toBeNull(); // window closed at the new publication
    });

    it('resolves only the asking tenant\'s packages', async () => {
      await store.publish({ tenant_id: TENANT_A, definition: makePackage('shared', '1.0.0', 'DENY'), published_by: PUBLISHER, effective_from: T0 });
      await store.publish({ tenant_id: TENANT_B, definition: makePackage('shared', '1.0.0', 'ALLOW'), published_by: PUBLISHER, effective_from: T0 });

      const a = await store.getActiveVersion(TENANT_A, 'shared', AFTER);
      const b = await store.getActiveVersion(TENANT_B, 'shared', AFTER);
      expect(a?.definition.rules[0]?.decision).toBe('DENY');
      expect(b?.definition.rules[0]?.decision).toBe('ALLOW');

      const listA = await store.listVersions(TENANT_A, 'shared');
      expect(listA).toHaveLength(1);
      expect(listA.every((v) => v.tenant_id === TENANT_A)).toBe(true);
    });

    it('serves a repeat current read from cache and never returns a stale version after publish', async () => {
      const past1 = new Date(Date.now() - 60_000);
      await store.publish({ tenant_id: TENANT_A, definition: makePackage('cached', '1.0.0'), published_by: PUBLISHER, effective_from: past1 });

      const r1 = await store.getActiveVersion(TENANT_A, 'cached');
      const r2 = await store.getActiveVersion(TENANT_A, 'cached');
      expect(r1).not.toBeNull();
      expect(r2).toBe(r1); // same instance → served from cache

      const past2 = new Date(Date.now() - 30_000); // after past1, still in the past
      await store.publish({ tenant_id: TENANT_A, definition: makePackage('cached', '1.1.0'), published_by: PUBLISHER, effective_from: past2 });

      const r3 = await store.getActiveVersion(TENANT_A, 'cached');
      expect(r3?.version).toBe('1.1.0'); // publish invalidated the cache — no stale read
      expect(r3).not.toBe(r1);
    });

    // PR-2 RULING — publish() runs the engine's shape validation
    // (validatePackage) and rejects an invalid package before any write.
    it('rejects a package that declares no default_disposition', async () => {
      const invalid = { ...makePackage('bad', '1.0.0'), default_disposition: undefined } as unknown as PolicyPackage;
      await expect(
        store.publish({ tenant_id: TENANT_A, definition: invalid, published_by: PUBLISHER, effective_from: T0 }),
      ).rejects.toMatchObject({ code: 'INVALID_PACKAGE' });
      // Nothing was persisted.
      expect(await store.listVersions(TENANT_A, 'bad')).toHaveLength(0);
    });

    it('rejects a package with a malformed rule (REQUIRES_OVERRIDE without a capability)', async () => {
      const invalid = {
        ...makePackage('bad', '1.0.0'),
        rules: [{ id: 'r1', resource: 'DOC', action: 'WRITE', decision: 'REQUIRES_OVERRIDE', reason_code: 'RULE_1' }],
      } as unknown as PolicyPackage;
      await expect(
        store.publish({ tenant_id: TENANT_A, definition: invalid, published_by: PUBLISHER, effective_from: T0 }),
      ).rejects.toMatchObject({ code: 'INVALID_PACKAGE' });
      expect(await store.listVersions(TENANT_A, 'bad')).toHaveLength(0);
    });

    it('accepts and stores a valid package', async () => {
      const published = await store.publish({ tenant_id: TENANT_A, definition: makePackage('good', '1.0.0'), published_by: PUBLISHER, effective_from: T0 });
      expect(published.version).toBe('1.0.0');
      expect(await store.listVersions(TENANT_A, 'good')).toHaveLength(1);
    });
  },
);
