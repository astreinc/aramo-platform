import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { computeEmailFingerprint } from '@aramo/common';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { IdentityIndexRepository } from '../lib/identity-index.repository.js';

// Step 4a integration test — brings up Postgres 17, applies the init
// migration, and proves the find/create primitives + the @@unique([fingerprint])
// same-human invariant against real SQL. The fingerprints are computed via the
// real @aramo/common primitive (with an explicit test pepper).

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260630000000_init_identity_index/migration.sql',
);

const PEPPER = 'integration-test-pepper';

// $$-aware DDL splitter (mirrors the libs/talent-trust harness; harmless for a
// migration with no $$ trigger bodies).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'IdentityIndexRepository — resolution store integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: IdentityIndexRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');

      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const stmt of splitDdl(migrationSql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new IdentityIndexRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('returns null for an unknown fingerprint (a new identity)', async () => {
      const fp = computeEmailFingerprint('nobody@example.com', PEPPER);
      expect(await repo.findClusterByFingerprint(fp)).toBeNull();
    });

    it('creates a cluster + fingerprint, then resolves the same cluster by fingerprint', async () => {
      const fp = computeEmailFingerprint('jane@example.com', PEPPER);
      const created = await repo.createClusterWithFingerprint(fp, 'email');
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

      const resolved = await repo.findClusterByFingerprint(fp);
      expect(resolved?.id).toBe(created.id);
    });

    it('enforces one-fingerprint-to-one-cluster (@@unique) — a duplicate fingerprint throws', async () => {
      const fp = computeEmailFingerprint('dupe@example.com', PEPPER);
      await repo.createClusterWithFingerprint(fp, 'email');
      await expect(
        repo.createClusterWithFingerprint(fp, 'email'),
      ).rejects.toThrow();
    });

    it('maps distinct fingerprints to distinct clusters', async () => {
      const fpA = computeEmailFingerprint('a-distinct@example.com', PEPPER);
      const fpB = computeEmailFingerprint('b-distinct@example.com', PEPPER);
      const a = await repo.createClusterWithFingerprint(fpA, 'email');
      const b = await repo.createClusterWithFingerprint(fpB, 'email');
      expect(a.id).not.toBe(b.id);
    });
  },
);
