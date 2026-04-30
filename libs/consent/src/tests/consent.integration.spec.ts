import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import {
  ConsentRepository,
  type RecordConsentEventInput,
} from '../lib/consent.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import type { ConsentGrantResponseDto } from '../lib/dto/consent-grant-response.dto.js';
import type { ConsentRevokeResponseDto } from '../lib/dto/consent-revoke-response.dto.js';

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const TALENT_ID_NOPRIOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaa999';
const TALENT_ID_MULTI = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaa1234';
const RECRUITER_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';

function baseGrantInput(overrides: Partial<RecordConsentEventInput> = {}): RecordConsentEventInput {
  return {
    tenant_id: TENANT_A,
    talent_id: TALENT_ID,
    action: 'granted',
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

function baseRevokeInput(overrides: Partial<RecordConsentEventInput> = {}): RecordConsentEventInput {
  return { ...baseGrantInput(), action: 'revoked', ...overrides };
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
      const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
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

    // ===================================================================
    // Grant cases (preserved from PR-2)
    // ===================================================================

    it('grant: writes consent + audit + outbox + idempotency rows in one transaction', async () => {
      const result = (await repo.recordConsentEvent(baseGrantInput())) as ConsentGrantResponseDto;
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

    it('grant: returns identical response on idempotent retry (same key, same hash)', async () => {
      const input = baseGrantInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000010',
        requestHash: 'hash-replay',
      });
      const first = await repo.recordConsentEvent(input);
      const second = await repo.recordConsentEvent(input);
      expect(second).toEqual(first);
      const consentCount = await prisma.talentConsentEvent.count({
        where: { tenant_id: TENANT_A, talent_id: TALENT_ID },
      });
      expect(consentCount).toBeGreaterThan(0);
    });

    it('grant: throws IDEMPOTENCY_KEY_CONFLICT for same key with a different hash', async () => {
      const key = 'aabbccdd-0000-7000-8000-000000000020';
      await repo.recordConsentEvent(baseGrantInput({ idempotencyKey: key, requestHash: 'h1' }));
      await expect(
        repo.recordConsentEvent(baseGrantInput({ idempotencyKey: key, requestHash: 'h2' })),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('grant: allows the same Idempotency-Key in different tenants', async () => {
      const sharedKey = 'aabbccdd-0000-7000-8000-000000000030';
      const a = await repo.recordConsentEvent(
        baseGrantInput({ tenant_id: TENANT_A, idempotencyKey: sharedKey, requestHash: 'h-a' }),
      );
      const b = await repo.recordConsentEvent(
        baseGrantInput({ tenant_id: TENANT_B, idempotencyKey: sharedKey, requestHash: 'h-b' }),
      );
      expect(a.tenant_id).toBe(TENANT_A);
      expect(b.tenant_id).toBe(TENANT_B);
      expect(a.event_id).not.toBe(b.event_id);
    });

    it('grant: rejects raw UPDATE on TalentConsentEvent (DB trigger; immutability layer 2)', async () => {
      const input = baseGrantInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000040',
        requestHash: 'h-trigger',
      });
      const result = await repo.recordConsentEvent(input);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE consent."TalentConsentEvent" SET action = 'revoked' WHERE id = '${result.event_id}'`,
        ),
      ).rejects.toThrow(/immutable/i);
    });

    // ===================================================================
    // Revoke cases (PR-3 — Decisions A / B / C / D)
    // ===================================================================

    it('revoke after prior grant: audit references the prior grant id (Decision A)', async () => {
      const grantInput = baseGrantInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000100',
        requestHash: 'h-rev-grant',
      });
      const grantResult = await repo.recordConsentEvent(grantInput);

      const revokeInput = baseRevokeInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000101',
        requestHash: 'h-rev-1',
      });
      const revokeResult = (await repo.recordConsentEvent(revokeInput)) as ConsentRevokeResponseDto;
      expect(revokeResult.action).toBe('revoked');
      expect(revokeResult.revoked_event_id).toBe(grantResult.event_id);

      const auditRows = await prisma.consentAuditEvent.findMany({
        where: { event_type: 'consent.revoke.recorded', subject_id: TALENT_ID },
        orderBy: { created_at: 'desc' },
        take: 1,
      });
      expect(auditRows).toHaveLength(1);
      const payload = auditRows[0]?.event_payload as Record<string, unknown>;
      expect(payload['revoked_event_id']).toBe(grantResult.event_id);
      expect(payload['in_flight_operations_halted']).toEqual([]);             // Decision B
      expect(payload['propagation_completed_at']).toBeNull();                 // Decision C
    });

    it('revoke without prior grant: revoked_event_id is null (Decision D)', async () => {
      const revokeInput = baseRevokeInput({
        talent_id: TALENT_ID_NOPRIOR,
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000110',
        requestHash: 'h-rev-noprior',
      });
      const result = (await repo.recordConsentEvent(revokeInput)) as ConsentRevokeResponseDto;
      expect(result.action).toBe('revoked');
      expect(result.revoked_event_id).toBeNull();

      const auditRows = await prisma.consentAuditEvent.findMany({
        where: { event_type: 'consent.revoke.recorded', subject_id: TALENT_ID_NOPRIOR },
      });
      expect(auditRows).toHaveLength(1);
      const payload = auditRows[0]?.event_payload as Record<string, unknown>;
      expect(payload['revoked_event_id']).toBeNull();
    });

    it('revoke after multiple grants: revoked_event_id references the most recent by occurred_at', async () => {
      // Seed two grants with different occurred_at; revoke should pick the most recent.
      const earlyGrant = await repo.recordConsentEvent(
        baseGrantInput({
          talent_id: TALENT_ID_MULTI,
          occurred_at: '2026-04-01T00:00:00Z',
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000120',
          requestHash: 'h-rev-multi-1',
        }),
      );
      const recentGrant = await repo.recordConsentEvent(
        baseGrantInput({
          talent_id: TALENT_ID_MULTI,
          occurred_at: '2026-04-15T00:00:00Z',
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000121',
          requestHash: 'h-rev-multi-2',
        }),
      );
      expect(earlyGrant.event_id).not.toBe(recentGrant.event_id);

      const revokeResult = (await repo.recordConsentEvent(
        baseRevokeInput({
          talent_id: TALENT_ID_MULTI,
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000122',
          requestHash: 'h-rev-multi-3',
        }),
      )) as ConsentRevokeResponseDto;
      expect(revokeResult.revoked_event_id).toBe(recentGrant.event_id);
    });

    it('revoke: idempotent retry returns identical response (including same revoked_event_id)', async () => {
      // First, seed a grant so the lookup has a target.
      await repo.recordConsentEvent(
        baseGrantInput({
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000130',
          requestHash: 'h-rev-replay-grant',
        }),
      );
      const revokeInput = baseRevokeInput({
        idempotencyKey: 'aabbccdd-0000-7000-8000-000000000131',
        requestHash: 'h-rev-replay',
      });
      const first = await repo.recordConsentEvent(revokeInput);
      const second = await repo.recordConsentEvent(revokeInput);
      expect(second).toStrictEqual(first);
    });

    it('revoke: idempotency conflict on same key + different body → 409', async () => {
      const key = 'aabbccdd-0000-7000-8000-000000000140';
      await repo.recordConsentEvent(baseRevokeInput({ idempotencyKey: key, requestHash: 'h-rev-c1' }));
      await expect(
        repo.recordConsentEvent(baseRevokeInput({ idempotencyKey: key, requestHash: 'h-rev-c2' })),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    });

    it('revoke: same Idempotency-Key in different tenants is allowed', async () => {
      const sharedKey = 'aabbccdd-0000-7000-8000-000000000150';
      const a = (await repo.recordConsentEvent(
        baseRevokeInput({ tenant_id: TENANT_A, idempotencyKey: sharedKey, requestHash: 'h-rev-mt-a' }),
      )) as ConsentRevokeResponseDto;
      const b = (await repo.recordConsentEvent(
        baseRevokeInput({ tenant_id: TENANT_B, idempotencyKey: sharedKey, requestHash: 'h-rev-mt-b' }),
      )) as ConsentRevokeResponseDto;
      expect(a.tenant_id).toBe(TENANT_A);
      expect(b.tenant_id).toBe(TENANT_B);
      expect(a.event_id).not.toBe(b.event_id);
    });

    it('revoke: DB trigger rejects raw UPDATE on the revoke event row (immutability layer 2)', async () => {
      const result = await repo.recordConsentEvent(
        baseRevokeInput({
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000160',
          requestHash: 'h-rev-trigger',
        }),
      );
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE consent."TalentConsentEvent" SET action = 'granted' WHERE id = '${result.event_id}'`,
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it('revoke: outbox event_payload contains revoked_event_id (or null)', async () => {
      const grantResult = await repo.recordConsentEvent(
        baseGrantInput({
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000170',
          requestHash: 'h-rev-outbox-grant',
        }),
      );
      const revokeResult = (await repo.recordConsentEvent(
        baseRevokeInput({
          idempotencyKey: 'aabbccdd-0000-7000-8000-000000000171',
          requestHash: 'h-rev-outbox-1',
        }),
      )) as ConsentRevokeResponseDto;

      const outboxRows = await prisma.outboxEvent.findMany({
        where: { event_type: 'consent.revoked' },
        orderBy: { created_at: 'desc' },
        take: 1,
      });
      expect(outboxRows).toHaveLength(1);
      const payload = outboxRows[0]?.event_payload as Record<string, unknown>;
      expect(payload['revoked_event_id']).toBe(grantResult.event_id);
      expect(payload['talent_id']).toBe(TALENT_ID);
      expect(revokeResult.revoked_event_id).toBe(grantResult.event_id);
    });
  },
);

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
