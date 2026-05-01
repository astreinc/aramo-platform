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

    // ===================================================================
    // Resolver cases (PR-4) — exercise resolveConsentState end-to-end
    // against real Postgres. Each case seeds via recordConsentEvent so
    // the ledger state is normal app-shape data.
    // ===================================================================

    const RESOLVER_TENANT = '33333333-3333-7333-8333-333333333333';
    const RESOLVER_TALENT = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

    async function seedGrant(
      scope: string,
      occurredAt: string,
      capturedMethod = 'recruiter_capture',
      idempKey?: string,
      metadata?: Record<string, unknown>,
    ): Promise<void> {
      await repo.recordConsentEvent({
        tenant_id: RESOLVER_TENANT,
        talent_id: RESOLVER_TALENT,
        action: 'granted',
        scope: scope as never,
        captured_method: capturedMethod as never,
        captured_by_actor_id: RECRUITER_ID,
        consent_version: 'v1',
        occurred_at: occurredAt,
        idempotencyKey:
          idempKey ?? `aabbccdd-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
        requestHash: `seed-${scope}-${capturedMethod}-${occurredAt}`,
        requestId: `seed-req-${scope}`,
        ...(metadata ? { metadata } : {}),
      });
    }

    it('resolver: empty ledger for an unseen talent → result=error reason=consent_state_unknown', async () => {
      const decision = await repo.resolveConsentState({
        tenant_id: RESOLVER_TENANT,
        talent_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', // unseeded
        operation: 'matching',
        requestHash: 'res-empty-h',
        requestId: 'res-empty-req',
      });
      expect(decision.result).toBe('error');
      expect(decision.reason_code).toBe('consent_state_unknown');
    });

    it('resolver: Counterintuitive Example — Indeed-source revoke + signup grant → contacting denied', async () => {
      const tenant = '44444444-4444-7444-8444-444444444444';
      const talent = 'cccccccc-cccc-7ccc-8ccc-ccccccccdd11';
      // Self-signup: full grants
      for (const [scope, idx] of [
        ['profile_storage', 0],
        ['matching', 1],
        ['contacting', 2],
      ] as const) {
        await repo.recordConsentEvent({
          tenant_id: tenant,
          talent_id: talent,
          action: 'granted',
          scope: scope as never,
          captured_method: 'self_signup',
          captured_by_actor_id: null,
          consent_version: 'v1',
          occurred_at: '2026-01-15T00:00:00Z',
          idempotencyKey: `aabbccdd-0000-7000-8000-cce${idx}00000010`,
          requestHash: `cci-self-${scope}`,
          requestId: 'cci-req-self',
        });
      }
      // Indeed-import: contacting revoked (the restriction)
      await repo.recordConsentEvent({
        tenant_id: tenant,
        talent_id: talent,
        action: 'revoked',
        scope: 'contacting',
        captured_method: 'import',
        captured_by_actor_id: null,
        consent_version: 'v1',
        occurred_at: '2026-02-10T00:00:00Z',
        idempotencyKey: 'aabbccdd-0000-7000-8000-cce300000099',
        requestHash: 'cci-indeed-rev',
        requestId: 'cci-req-indeed',
      });

      const decision = await repo.resolveConsentState({
        tenant_id: tenant,
        talent_id: talent,
        operation: 'engagement',
        channel: 'email',
        requestHash: 'cci-check-h',
        requestId: 'cci-check-req',
      });
      expect(decision.result).toBe('denied');
      expect(decision.denied_scopes).toContain('contacting');
    });

    it('resolver: dependency unmet → 422 with embedded ConsentDecision in error.details', async () => {
      const tenant = '55555555-5555-7555-8555-555555555555';
      const talent = 'cccccccc-cccc-7ccc-8ccc-ccccccccdd22';
      // Only profile_storage + contacting; matching dep missing
      await repo.recordConsentEvent({
        tenant_id: tenant,
        talent_id: talent,
        action: 'granted',
        scope: 'profile_storage',
        captured_method: 'recruiter_capture',
        captured_by_actor_id: RECRUITER_ID,
        consent_version: 'v1',
        occurred_at: '2026-04-01T00:00:00Z',
        idempotencyKey: 'aabbccdd-0000-7000-8000-dd2200000001',
        requestHash: 'dep-h-1',
        requestId: 'dep-req-1',
      });
      await repo.recordConsentEvent({
        tenant_id: tenant,
        talent_id: talent,
        action: 'granted',
        scope: 'contacting',
        captured_method: 'recruiter_capture',
        captured_by_actor_id: RECRUITER_ID,
        consent_version: 'v1',
        occurred_at: '2026-04-01T00:00:00Z',
        idempotencyKey: 'aabbccdd-0000-7000-8000-dd2200000002',
        requestHash: 'dep-h-2',
        requestId: 'dep-req-2',
      });
      try {
        await repo.resolveConsentState({
          tenant_id: tenant,
          talent_id: talent,
          operation: 'engagement',
          channel: 'email',
          requestHash: 'dep-check-h',
          requestId: 'dep-check-req',
        });
        throw new Error('expected 422 to be thrown');
      } catch (err) {
        const aramoErr = err as {
          code: string;
          statusCode: number;
          context: { details: { consent_decision: { reason_code: string; denied_scopes: string[] } } };
        };
        expect(aramoErr.code).toBe('INVALID_SCOPE_COMBINATION');
        expect(aramoErr.statusCode).toBe(422);
        expect(aramoErr.context.details.consent_decision.reason_code).toBe('scope_dependency_unmet');
        expect(aramoErr.context.details.consent_decision.denied_scopes).toContain('matching');
      }

      // Decision H: audit row persists for the 422 path
      const auditRows = await prisma.consentAuditEvent.findMany({
        where: { tenant_id: tenant, event_type: 'consent.check.decision' },
      });
      expect(auditRows.length).toBeGreaterThan(0);
    });

    it('resolver: 13-month-old contacting grant → denied with reason=stale_consent', async () => {
      const tenant = '66666666-6666-7666-8666-666666666666';
      const talent = 'cccccccc-cccc-7ccc-8ccc-ccccccccdd33';
      const thirteenMonthsAgo = new Date();
      thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
      const stamp = thirteenMonthsAgo.toISOString();
      for (const [scope, idx] of [
        ['profile_storage', 0],
        ['matching', 1],
        ['contacting', 2],
      ] as const) {
        await repo.recordConsentEvent({
          tenant_id: tenant,
          talent_id: talent,
          action: 'granted',
          scope: scope as never,
          captured_method: 'recruiter_capture',
          captured_by_actor_id: RECRUITER_ID,
          consent_version: 'v1',
          occurred_at: stamp,
          idempotencyKey: `aabbccdd-0000-7000-8000-dd33${idx.toString().padStart(8, '0')}`,
          requestHash: `stale-h-${scope}`,
          requestId: `stale-req-${scope}`,
        });
      }
      const decision = await repo.resolveConsentState({
        tenant_id: tenant,
        talent_id: talent,
        operation: 'engagement',
        channel: 'email',
        requestHash: 'stale-check-h',
        requestId: 'stale-check-req',
      });
      expect(decision.result).toBe('denied');
      expect(decision.reason_code).toBe('stale_consent');
      expect(decision.display_message).toBe('Consent has expired. Refresh required.');
    });

    it('resolver: persists decision-log audit row queryable post-check (Decision H)', async () => {
      const tenant = '77777777-7777-7777-8777-777777777777';
      const talent = 'cccccccc-cccc-7ccc-8ccc-ccccccccdd44';
      // Grant matching dep + the matching scope itself
      for (const [scope, idx] of [
        ['profile_storage', 0],
        ['matching', 1],
      ] as const) {
        await repo.recordConsentEvent({
          tenant_id: tenant,
          talent_id: talent,
          action: 'granted',
          scope: scope as never,
          captured_method: 'recruiter_capture',
          captured_by_actor_id: RECRUITER_ID,
          consent_version: 'v1',
          occurred_at: '2026-04-15T00:00:00Z',
          idempotencyKey: `aabbccdd-0000-7000-8000-dd44${idx.toString().padStart(8, '0')}`,
          requestHash: `audit-h-${scope}`,
          requestId: `audit-req-${scope}`,
        });
      }
      const decision = await repo.resolveConsentState({
        tenant_id: tenant,
        talent_id: talent,
        operation: 'matching',
        requestHash: 'audit-check-h',
        requestId: 'audit-check-req',
      });
      expect(decision.result).toBe('allowed');

      const auditRows = await prisma.consentAuditEvent.findMany({
        where: { tenant_id: tenant, event_type: 'consent.check.decision' },
      });
      expect(auditRows).toHaveLength(1);
      const payload = auditRows[0]?.event_payload as Record<string, unknown>;
      expect(payload['decision_id']).toBe(decision.decision_id);
      expect(payload['result']).toBe('allowed');
      expect(payload['operation']).toBe('matching');
    });

    // Suppress unused-variable warning — seedGrant kept for future
    // resolver scenarios that don't fit the inline seed pattern above.
    void seedGrant;

    // ===================================================================
    // State endpoint cases (PR-5) — exercise resolveAllScopes end-to-end
    // against real Postgres. Verifies:
    //   - Always 5 scopes in response (Decision D)
    //   - Per-scope state derivation against real ledger
    //   - is_anonymized always false (Decision F PR-5 limitation)
    //   - No ConsentAuditEvent rows written (Decision H)
    //   - No idempotency rows written
    // ===================================================================

    const STATE_TENANT = '88888888-8888-7888-8888-888888888888';

    it('state: empty ledger for an unseen talent → 5 scopes all no_grant, no audit row', async () => {
      const talent = 'cccccccc-cccc-7ccc-8ccc-ccccccccdd55';
      const auditCountBefore = await prisma.consentAuditEvent.count({
        where: { tenant_id: STATE_TENANT },
      });
      const result = await repo.resolveAllScopes({
        tenant_id: STATE_TENANT,
        talent_id: talent,
        requestId: 'state-empty-req',
      });
      expect(result.scopes).toHaveLength(5);
      for (const s of result.scopes) {
        expect(s.status).toBe('no_grant');
        expect(s.granted_at).toBeNull();
        expect(s.revoked_at).toBeNull();
        expect(s.expires_at).toBeNull();
      }
      expect(result.is_anonymized).toBe(false);
      expect(result.tenant_id).toBe(STATE_TENANT);
      expect(result.talent_id).toBe(talent);
      // Decision H: no audit row written for state reads
      const auditCountAfter = await prisma.consentAuditEvent.count({
        where: { tenant_id: STATE_TENANT },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('state: mixed ledger (matching granted, contacting revoked) → correct per-scope status', async () => {
      const tenant = '99999999-9999-7999-8999-999999999999';
      const talent = 'cccccccc-cccc-7ccc-8ccc-ccccccccdd66';
      // Profile + matching granted
      for (const [scope, idx] of [
        ['profile_storage', 0],
        ['matching', 1],
      ] as const) {
        await repo.recordConsentEvent({
          tenant_id: tenant,
          talent_id: talent,
          action: 'granted',
          scope: scope as never,
          captured_method: 'recruiter_capture',
          captured_by_actor_id: RECRUITER_ID,
          consent_version: 'v1',
          occurred_at: '2026-04-01T10:00:00Z',
          idempotencyKey: `aabbccdd-0000-7000-8000-dd66${idx.toString().padStart(8, '0')}`,
          requestHash: `state-mixed-h-${scope}-grant`,
          requestId: `state-mixed-req-${scope}-grant`,
        });
      }
      // Contacting granted then revoked
      await repo.recordConsentEvent({
        tenant_id: tenant,
        talent_id: talent,
        action: 'granted',
        scope: 'contacting',
        captured_method: 'recruiter_capture',
        captured_by_actor_id: RECRUITER_ID,
        consent_version: 'v1',
        occurred_at: '2026-04-01T11:00:00Z',
        idempotencyKey: 'aabbccdd-0000-7000-8000-dd6600000010',
        requestHash: 'state-mixed-h-contacting-grant',
        requestId: 'state-mixed-req-contacting-grant',
      });
      await repo.recordConsentEvent({
        tenant_id: tenant,
        talent_id: talent,
        action: 'revoked',
        scope: 'contacting',
        captured_method: 'recruiter_capture',
        captured_by_actor_id: RECRUITER_ID,
        consent_version: 'v1',
        occurred_at: '2026-04-15T14:22:00Z',
        idempotencyKey: 'aabbccdd-0000-7000-8000-dd6600000011',
        requestHash: 'state-mixed-h-contacting-revoke',
        requestId: 'state-mixed-req-contacting-revoke',
      });

      const result = await repo.resolveAllScopes({
        tenant_id: tenant,
        talent_id: talent,
        requestId: 'state-mixed-req',
      });

      expect(result.scopes).toHaveLength(5);

      const profile = result.scopes.find((s) => s.scope === 'profile_storage');
      expect(profile?.status).toBe('granted');
      const matching = result.scopes.find((s) => s.scope === 'matching');
      expect(matching?.status).toBe('granted');
      const contacting = result.scopes.find((s) => s.scope === 'contacting');
      expect(contacting?.status).toBe('revoked');
      expect(contacting?.granted_at).toBe('2026-04-01T11:00:00.000Z');
      expect(contacting?.revoked_at).toBe('2026-04-15T14:22:00.000Z');
      const resume = result.scopes.find((s) => s.scope === 'resume_processing');
      expect(resume?.status).toBe('no_grant');
      const xtenant = result.scopes.find((s) => s.scope === 'cross_tenant_visibility');
      expect(xtenant?.status).toBe('no_grant');
    });

    it('state: Counterintuitive Example end-to-end (Indeed-import revoked + signup full → contacting=revoked)', async () => {
      const tenant = 'aaaa1111-aaaa-7aaa-8aaa-111111111111';
      const talent = 'cccccccc-cccc-7ccc-8ccc-ccccccccdd77';
      // Self-signup: full grants
      for (const [scope, idx] of [
        ['profile_storage', 0],
        ['matching', 1],
        ['contacting', 2],
      ] as const) {
        await repo.recordConsentEvent({
          tenant_id: tenant,
          talent_id: talent,
          action: 'granted',
          scope: scope as never,
          captured_method: 'self_signup',
          captured_by_actor_id: null,
          consent_version: 'v1',
          occurred_at: '2026-01-15T00:00:00Z',
          idempotencyKey: `aabbccdd-0000-7000-8000-dd77${idx.toString().padStart(8, '0')}`,
          requestHash: `cci-state-self-${scope}`,
          requestId: 'cci-state-req-self',
        });
      }
      // Indeed-import: contacting revoked
      await repo.recordConsentEvent({
        tenant_id: tenant,
        talent_id: talent,
        action: 'revoked',
        scope: 'contacting',
        captured_method: 'import',
        captured_by_actor_id: null,
        consent_version: 'v1',
        occurred_at: '2026-02-10T00:00:00Z',
        idempotencyKey: 'aabbccdd-0000-7000-8000-dd7700000099',
        requestHash: 'cci-state-indeed-rev',
        requestId: 'cci-state-req-indeed',
      });

      const result = await repo.resolveAllScopes({
        tenant_id: tenant,
        talent_id: talent,
        requestId: 'cci-state-req',
      });

      const contacting = result.scopes.find((s) => s.scope === 'contacting');
      expect(contacting?.status).toBe('revoked');
      // Latest grant timestamp preserved (self_signup grant)
      expect(contacting?.granted_at).toBe('2026-01-15T00:00:00.000Z');
      // Latest revoke timestamp (Indeed import)
      expect(contacting?.revoked_at).toBe('2026-02-10T00:00:00.000Z');
    });

    // ===================================================================
    // History endpoint cases (PR-6) — exercise resolveHistory end-to-end
    // against real Postgres. Verifies §7 tests 10, 11, 12.
    // ===================================================================

    it('history §7 test 10: strictly-older invariant under identical timestamps', async () => {
      // The fencepost-bug catcher. Insert N events with the SAME
      // created_at, page through with limit=2, assert no duplicates and
      // no skips across page boundaries. Setup: direct prisma.createMany
      // (recordConsentEvent doesn't accept explicit created_at).
      const tenant = 'eeeeee01-eeee-7eee-8eee-eeeeeeeeeeee';
      const talent = 'cccccccc-cccc-7ccc-8ccc-cccccccceeee';
      const sameTime = new Date('2026-04-15T12:00:00Z');
      const ids = [
        'aabbccdd-0000-7000-8000-000010000001',
        'aabbccdd-0000-7000-8000-000010000002',
        'aabbccdd-0000-7000-8000-000010000003',
        'aabbccdd-0000-7000-8000-000010000004',
        'aabbccdd-0000-7000-8000-000010000005',
      ];
      // Direct prisma.createMany — precedented in this file
      // (lines 88+ use direct prisma.* access for setup/assertions).
      await prisma.talentConsentEvent.createMany({
        data: ids.map((id) => ({
          id,
          tenant_id: tenant,
          talent_id: talent,
          scope: 'matching',
          action: 'granted',
          captured_method: 'recruiter_capture',
          captured_by_actor_id: RECRUITER_ID,
          consent_version: 'v1',
          occurred_at: sameTime,
          created_at: sameTime, // explicit override; identical timestamps
        })),
      });

      // Page through with limit=2, collecting all event_ids
      const collected: string[] = [];
      let cursor: string | null | undefined = undefined;
      let pages = 0;
      const maxPages = 10; // safety: should converge in 3 pages (5 events / limit 2)
      while (pages < maxPages) {
        const page = await repo.resolveHistory({
          tenant_id: tenant,
          talent_id: talent,
          limit: 2,
          ...(cursor !== null && cursor !== undefined
            ? {
                cursor: (() => {
                  const decoded = JSON.parse(
                    Buffer.from(cursor, 'base64url').toString('utf8'),
                  ) as { c: string; e: string };
                  return {
                    created_at: new Date(decoded.c),
                    event_id: decoded.e,
                  };
                })(),
              }
            : {}),
          requestId: `history-page-${pages}`,
        });
        for (const ev of page.events) {
          collected.push(ev.event_id);
        }
        cursor = page.next_cursor;
        pages += 1;
        if (cursor === null) break;
      }

      // No duplicates
      const unique = [...new Set(collected)];
      expect(unique.length).toBe(collected.length);
      // No skips: all 5 ids returned exactly once
      expect(unique.length).toBe(5);
      expect([...unique].sort()).toEqual([...ids].sort());
    });

    it('history §7 test 11: staleness preservation — 14-month-old grant returns as granted', async () => {
      const tenant = 'eeeeee02-eeee-7eee-8eee-eeeeeeeeeeee';
      const talent = 'cccccccc-cccc-7ccc-8ccc-cccccccceee2';
      const fourteenMonthsAgo = new Date();
      fourteenMonthsAgo.setMonth(fourteenMonthsAgo.getMonth() - 14);
      // Direct createMany so we can pin created_at to 14 months ago
      await prisma.talentConsentEvent.createMany({
        data: [
          {
            id: 'aabbccdd-0000-7000-8000-000020000001',
            tenant_id: tenant,
            talent_id: talent,
            scope: 'contacting',
            action: 'granted',
            captured_method: 'recruiter_capture',
            captured_by_actor_id: RECRUITER_ID,
            consent_version: 'v1',
            occurred_at: fourteenMonthsAgo,
            created_at: fourteenMonthsAgo,
          },
        ],
      });

      const page = await repo.resolveHistory({
        tenant_id: tenant,
        talent_id: talent,
        limit: 50,
        requestId: 'history-stale-req',
      });

      expect(page.events).toHaveLength(1);
      const ev = page.events[0];
      expect(ev?.action).toBe('granted'); // preserved, NOT 'expired'/'stale'
      // No staleness indicator anywhere on the response
      expect(Object.keys(ev as object).sort()).toEqual([
        'action',
        'created_at',
        'event_id',
        'expires_at',
        'scope',
      ]);
      expect(Object.keys(page).sort()).toEqual([
        'events',
        'is_anonymized',
        'next_cursor',
      ]);
    });

    it('history §7 test 12: cross-tenant isolation — same talent_id in two tenants returns disjoint event sets', async () => {
      const tenantA = 'eeeeee03-eeee-7eee-8eee-eeeeeeeeeeea';
      const tenantB = 'eeeeee03-eeee-7eee-8eee-eeeeeeeeeeeb';
      const sharedTalent = 'cccccccc-cccc-7ccc-8ccc-cccccccceee3';

      await prisma.talentConsentEvent.createMany({
        data: [
          {
            id: 'aabbccdd-0000-7000-8000-000030000001',
            tenant_id: tenantA,
            talent_id: sharedTalent,
            scope: 'matching',
            action: 'granted',
            captured_method: 'recruiter_capture',
            captured_by_actor_id: RECRUITER_ID,
            consent_version: 'v1',
            occurred_at: new Date('2026-04-01T10:00:00Z'),
            created_at: new Date('2026-04-01T10:00:00Z'),
          },
          {
            id: 'aabbccdd-0000-7000-8000-000030000002',
            tenant_id: tenantB,
            talent_id: sharedTalent,
            scope: 'profile_storage',
            action: 'granted',
            captured_method: 'self_signup',
            captured_by_actor_id: null,
            consent_version: 'v1',
            occurred_at: new Date('2026-04-02T10:00:00Z'),
            created_at: new Date('2026-04-02T10:00:00Z'),
          },
        ],
      });

      const tenantAResult = await repo.resolveHistory({
        tenant_id: tenantA,
        talent_id: sharedTalent,
        limit: 50,
        requestId: 'history-iso-a',
      });
      const tenantBResult = await repo.resolveHistory({
        tenant_id: tenantB,
        talent_id: sharedTalent,
        limit: 50,
        requestId: 'history-iso-b',
      });

      expect(tenantAResult.events).toHaveLength(1);
      expect(tenantAResult.events[0]?.event_id).toBe(
        'aabbccdd-0000-7000-8000-000030000001',
      );
      expect(tenantAResult.events[0]?.scope).toBe('matching');

      expect(tenantBResult.events).toHaveLength(1);
      expect(tenantBResult.events[0]?.event_id).toBe(
        'aabbccdd-0000-7000-8000-000030000002',
      );
      expect(tenantBResult.events[0]?.scope).toBe('profile_storage');

      // No cross-contamination
      const tenantAIds = tenantAResult.events.map((e) => e.event_id);
      const tenantBIds = tenantBResult.events.map((e) => e.event_id);
      for (const id of tenantAIds) {
        expect(tenantBIds).not.toContain(id);
      }
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
