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

    // ---- TR-2a-B1 §6(a) — server-derived source_class persists ----------
    async function persistedSourceClass(id: string): Promise<string> {
      const r = await prisma.$queryRawUnsafe<{ source_class: string }[]>(
        `SELECT source_class FROM "ingestion"."RawPayloadReference" WHERE id = '${id}'::uuid`,
      );
      return r[0]!.source_class;
    }

    it('§6(a) — each mapped channel persists its ruled source_class on the payload row', async () => {
      const tenantId = uuidv7();
      const cases: Array<[string, string]> = [
        ['talent_direct', 'SELF'],
        ['github', 'THIRD_PARTY_UNVERIFIED'],
        ['astre_import', 'THIRD_PARTY_UNVERIFIED'],
        ['indeed', 'THIRD_PARTY_UNVERIFIED'],
      ];
      for (const [source, expected] of cases) {
        const r = await service.acceptPayload({
          tenant_id: tenantId,
          request: {
            source,
            storage_ref: 's3://x/' + source + '.json',
            sha256: shaHex('sc-' + source + '-' + tenantId),
            content_type: 'application/json',
            captured_at: '2026-07-06T12:00:00.000Z',
          },
        });
        expect(r.status).toBe('accepted');
        expect(await persistedSourceClass(r.id)).toBe(expected);
      }
    });

    it('§6(a) — an unmapped source persists the fail-closed THIRD_PARTY_UNVERIFIED default', async () => {
      // The DTO closes the wire vocabulary, but the service is fail-closed for
      // ANY source (DDR-1 §4): a future/unmapped channel never confirms by
      // omission. Exercised at the service layer with a source outside the map.
      const tenantId = uuidv7();
      const r = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'a_future_unmapped_channel' as never,
          storage_ref: 's3://x/unmapped.json',
          sha256: shaHex('sc-unmapped-' + tenantId),
          content_type: 'application/json',
          captured_at: '2026-07-06T12:00:00.000Z',
        },
      });
      expect(await persistedSourceClass(r.id)).toBe('THIRD_PARTY_UNVERIFIED');
    });

    // ---- Cold-Ingest Extraction poll (extract-once gate) -----------------
    // findArrivalsNeedingExtraction + markExtractionDone + bumpExtractionAttempt
    // against the real extraction_done_at / extraction_attempts columns. The
    // poll is global (no tenant filter); we scope assertions to our own ids so
    // other tests' (never-resolved) rows do not interfere.

    async function accept(tenantId: string, seed: string): Promise<string> {
      const r = await service.acceptPayload({
        tenant_id: tenantId,
        request: {
          source: 'talent_direct',
          storage_ref: 's3://aramo-raw-ingestion/' + tenantId + '/' + seed + '.pdf',
          sha256: shaHex(seed + '-' + tenantId),
          content_type: 'application/pdf',
          captured_at: '2026-07-04T12:00:00.000Z',
        },
      });
      return r.id;
    }
    async function setResolved(id: string, subjectId: string): Promise<void> {
      await prisma.$executeRawUnsafe(
        `UPDATE "ingestion"."RawPayloadReference" SET "resolved_subject_id" = '${subjectId}'::uuid WHERE id = '${id}'::uuid`,
      );
    }

    it('poll returns only resolved + unextracted rows under the attempt cap', async () => {
      const tenant = uuidv7();
      const eligible = await accept(tenant, 'poll-eligible');
      const unresolved = await accept(tenant, 'poll-unresolved');
      const alreadyDone = await accept(tenant, 'poll-done');
      const atCap = await accept(tenant, 'poll-atcap');

      const subject = uuidv7();
      await setResolved(eligible, subject);
      // unresolved: resolved_subject_id stays NULL → excluded.
      await setResolved(alreadyDone, uuidv7());
      await prisma.$executeRawUnsafe(
        `UPDATE "ingestion"."RawPayloadReference" SET "extraction_done_at" = now() WHERE id = '${alreadyDone}'::uuid`,
      );
      await setResolved(atCap, uuidv7());
      await prisma.$executeRawUnsafe(
        `UPDATE "ingestion"."RawPayloadReference" SET "extraction_attempts" = 5 WHERE id = '${atCap}'::uuid`,
      );

      const repo = new IngestionRepository(prisma);
      const arrivals = await repo.findArrivalsNeedingExtraction({
        limit: 100,
        maxAttempts: 5,
      });
      const myIds = new Set([eligible, unresolved, alreadyDone, atCap]);
      const returnedMine = arrivals.filter((a) => myIds.has(a.id));
      expect(returnedMine.map((a) => a.id)).toEqual([eligible]);
      expect(returnedMine[0]?.resolved_subject_id).toBe(subject);
      expect(returnedMine[0]?.storage_ref).toContain('poll-eligible');
    });

    it('markExtractionDone stamps the gate so the row drops out of the poll', async () => {
      const tenant = uuidv7();
      const id = await accept(tenant, 'mark-done');
      await setResolved(id, uuidv7());
      const repo = new IngestionRepository(prisma);

      const before = await repo.findArrivalsNeedingExtraction({ limit: 100, maxAttempts: 5 });
      expect(before.some((a) => a.id === id)).toBe(true);

      await repo.markExtractionDone(id);
      const after = await repo.findArrivalsNeedingExtraction({ limit: 100, maxAttempts: 5 });
      expect(after.some((a) => a.id === id)).toBe(false);
    });

    it('bumpExtractionAttempt increments; the row drops out at the cap', async () => {
      const tenant = uuidv7();
      const id = await accept(tenant, 'bump-attempt');
      await setResolved(id, uuidv7());
      const repo = new IngestionRepository(prisma);

      for (let i = 0; i < 5; i += 1) {
        await repo.bumpExtractionAttempt(id);
      }
      // attempts === 5 is NOT < maxAttempts(5) → excluded.
      const atCap = await repo.findArrivalsNeedingExtraction({ limit: 100, maxAttempts: 5 });
      expect(atCap.some((a) => a.id === id)).toBe(false);
      // A higher cap re-admits it (still not done).
      const higherCap = await repo.findArrivalsNeedingExtraction({ limit: 100, maxAttempts: 6 });
      expect(higherCap.some((a) => a.id === id)).toBe(true);
    });
  },
);
