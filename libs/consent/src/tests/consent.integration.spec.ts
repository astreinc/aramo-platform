import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { ConsentRepository, type RecordGrantEventInput } from '../lib/consent.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function baseInput(overrides: Partial<RecordGrantEventInput> = {}): RecordGrantEventInput {
  return {
    tenant_id: TENANT_A,
    talent_id: TALENT_ID,
    scope: 'matching',
    captured_method: 'recruiter_capture',
    captured_by_actor_id: RECRUITER_ID,
    consent_version: 'v1',
    occurred_at: '2026-04-29T00:00:00Z',
    idempotencyKey: 'aabbccdd-0000-7000-8000-000000000001',
    requestHash: 'hash-A',
    requestId: 'req-int-1',
    ...overrides,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ConsentRepository — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: ConsentRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      // Apply migration
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      // Use raw queries for DDL — Prisma's $executeRawUnsafe runs each
      // statement individually; split on `;` at semicolon boundaries.
      // Functions / triggers contain `$$` blocks; treat the trigger as a
      // single block.
      const statements = splitDdl(migrationSql);
      for (const stmt of statements) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ConsentRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('writes consent + audit + outbox + idempotency rows in one transaction', async () => {
      const result = await repo.recordGrantEvent(baseInput());
      expect(result.action).toBe('granted');
      expect(result.tenant_id).toBe(TENANT_A);

      const consentCount = await prisma.talentConsentEvent.count({ where: { tenant_id: TENANT_A } });
      const auditCount = await prisma.consentAuditEvent.count({ where: { tenant_id: TENANT_A } });
      const outboxCount = await prisma.outboxEvent.count({ where: { tenant_id: TENANT_A } });
      const idemCount = await prisma.idempotencyKey.count({ where: { tenant_id: TENANT_A } });
      expect(consentCount).toBe(1);
      expect(auditCount).toBe(1);
      expect(outboxCount).toBe(1);
      expect(idemCount).toBe(1);
    });

    it('returns identical response on idempotent retry (same key, same hash)', async () => {
      const input = baseInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000010',
        requestHash: 'hash-replay',
      });
      const first = await repo.recordGrantEvent(input);
      const second = await repo.recordGrantEvent(input);
      expect(second).toEqual(first);
      const consentCount = await prisma.talentConsentEvent.count({
        where: { tenant_id: TENANT_A, talent_id: TALENT_ID },
      });
      // Only the first call wrote; the replay returned the persisted body.
      expect(consentCount).toBeGreaterThan(0);
    });

    it('throws IDEMPOTENCY_KEY_CONFLICT for same key with a different hash', async () => {
      const key = 'aabbccdd-0000-7000-8000-000000000020';
      await repo.recordGrantEvent(baseInput({ idempotencyKey: key, requestHash: 'h1' }));
      await expect(
        repo.recordGrantEvent(baseInput({ idempotencyKey: key, requestHash: 'h2' })),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('allows the same Idempotency-Key in different tenants', async () => {
      const sharedKey = 'aabbccdd-0000-7000-8000-000000000030';
      const a = await repo.recordGrantEvent(
        baseInput({ tenant_id: TENANT_A, idempotencyKey: sharedKey, requestHash: 'h-a' }),
      );
      const b = await repo.recordGrantEvent(
        baseInput({ tenant_id: TENANT_B, idempotencyKey: sharedKey, requestHash: 'h-b' }),
      );
      expect(a.tenant_id).toBe(TENANT_A);
      expect(b.tenant_id).toBe(TENANT_B);
      expect(a.event_id).not.toBe(b.event_id);
    });

    it('rejects raw UPDATE on TalentConsentEvent (DB trigger; immutability layer 2)', async () => {
      const input = baseInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000040',
        requestHash: 'h-trigger',
      });
      const result = await repo.recordGrantEvent(input);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE consent."TalentConsentEvent" SET action = 'revoked' WHERE id = '${result.event_id}'`,
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it('persists action="granted" regardless of any client value (defense-in-depth)', async () => {
      const input = {
        ...baseInput({
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000050',
          requestHash: 'h-action',
        }),
        action: 'revoked',
      } as unknown as RecordGrantEventInput;
      const result = await repo.recordGrantEvent(input);
      expect(result.action).toBe('granted');
      const row = await prisma.talentConsentEvent.findUnique({
        where: { id: result.event_id },
      });
      expect(row?.action).toBe('granted');
    });
  },
);

function splitDdl(sql: string): string[] {
  // Split on semicolons that are NOT inside `$$ ... $$` plpgsql blocks.
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
