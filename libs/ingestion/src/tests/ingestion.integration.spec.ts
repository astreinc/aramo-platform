import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { IngestionRepository } from '../lib/ingestion.repository.js';
import { IngestionService } from '../lib/ingestion.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// No-op SourceConsentService stub — PR-12 integration tests exercise
// the generic /payloads path which does not call source-consent. The
// Indeed-side R5 honest-visibility test lives in indeed.service.spec.ts.
function makeSourceConsentStub(): never {
  return {
    registerSourceDerivedConsent: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');

// All migration SQL files in chronological order (Prisma-migration
// directories carry timestamped prefixes, so a lexical sort matches
// chronological order). Applying every migration in sequence brings
// the test Postgres up to the current schema state, mirroring how
// `prisma migrate deploy` runs in production.
function findAllMigrationSqlPaths(): string[] {
  const subdirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
    .map((d) => d.name)
    .sort();
  if (subdirs.length === 0) {
    throw new Error('no ingestion migrations found');
  }
  return subdirs.map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));
}

// Mirrors the libs/talent / libs/identity splitDdl: strip line comments
// first, then split on statement-boundary semicolons.
function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function shaHex(seed: string): string {
  // Deterministic 64-hex-char string from a seed (not a real sha256 —
  // these tests do not exercise hashing; they exercise dedup paths).
  const base = seed.padEnd(64, '0').slice(0, 64);
  return base.replace(/[^0-9a-f]/gi, 'a').toLowerCase();
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Ingestion module — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let service: IngestionService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      // Apply every migration in chronological order — init schema
      // (PR-12) + the skill_surface_forms column (PR-13).
      for (const migrationPath of findAllMigrationSqlPaths()) {
        const migrationSql = readFileSync(migrationPath, 'utf8');
        for (const stmt of splitDdl(migrationSql)) {
          await setupClient.$executeRawUnsafe(stmt);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      service = new IngestionService(new IngestionRepository(prisma), makeSourceConsentStub());
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('accepts a fresh payload — status=accepted, dedup.match_signal=null', async () => {
      const tenantId = uuidv7();
      const result = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://aramo-raw-ingestion/' + tenantId + '/p1.json',
          sha256: shaHex('p1-' + tenantId),
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:00.000Z',
        },
      });
      expect(result.status).toBe('accepted');
      expect(result.dedup.match_signal).toBeNull();
      expect(result.dedup.existing_payload_id).toBeNull();
      expect(result.tenant_id).toBe(tenantId);
    });

    it('dedup by sha256 — same (tenant_id, sha256) returns duplicate with existing id', async () => {
      const tenantId = uuidv7();
      const sha = shaHex('sha-dup-' + tenantId);
      const first = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/y1.json',
          sha256: sha,
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:00.000Z',
        },
      });
      const second = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/y2.json',
          sha256: sha,
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:01.000Z',
        },
      });
      expect(first.status).toBe('accepted');
      expect(second.status).toBe('duplicate');
      expect(second.dedup.match_signal).toBe('sha256');
      expect(second.dedup.existing_payload_id).toBe(first.id);
    });

    it('dedup by verified_email — same tenant + same normalized email returns duplicate', async () => {
      const tenantId = uuidv7();
      const email = 'jane@example.com';
      const first = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/y1.json',
          sha256: shaHex('email-1-' + tenantId),
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:00.000Z',
          verified_email: email,
        },
      });
      const second = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/y2.json',
          sha256: shaHex('email-2-' + tenantId),
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:01.000Z',
          // Normalization: trim + lowercase
          verified_email: '  Jane@Example.COM  ',
        },
      });
      expect(first.status).toBe('accepted');
      expect(second.status).toBe('duplicate');
      expect(second.dedup.match_signal).toBe('verified_email');
      expect(second.dedup.existing_payload_id).toBe(first.id);
    });

    it('dedup by profile_url — same tenant + same profile URL returns duplicate', async () => {
      const tenantId = uuidv7();
      const url = 'https://example.com/jane';
      const first = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/y1.json',
          sha256: shaHex('url-1-' + tenantId),
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:00.000Z',
          profile_url: url,
        },
      });
      const second = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/y2.json',
          sha256: shaHex('url-2-' + tenantId),
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:01.000Z',
          profile_url: '  ' + url + '  ',
        },
      });
      expect(first.status).toBe('accepted');
      expect(second.status).toBe('duplicate');
      expect(second.dedup.match_signal).toBe('profile_url');
      expect(second.dedup.existing_payload_id).toBe(first.id);
    });

    it('tenant isolation — same sha256 in two tenants are NOT duplicates (R5 honest visibility)', async () => {
      const tenantA = uuidv7();
      const tenantB = uuidv7();
      const sha = shaHex('xtenant-' + tenantA);
      const aResult = await service.acceptPayload({
        tenant_id: tenantA,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/a.json',
          sha256: sha,
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:00.000Z',
        },
      });
      const bResult = await service.acceptPayload({
        tenant_id: tenantB,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://x/b.json',
          sha256: sha,
          content_type: 'application/json',
          captured_at: '2026-05-16T12:00:00.000Z',
        },
      });
      expect(aResult.status).toBe('accepted');
      expect(bResult.status).toBe('accepted');
      expect(bResult.tenant_id).toBe(tenantB);
      expect(bResult.id).not.toBe(aResult.id);
    });
  },
);
