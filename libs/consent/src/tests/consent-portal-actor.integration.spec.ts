import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConsentRepository } from '../lib/consent.repository.js';
import { ConsentService } from '../lib/consent.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// Portal P2 P2a (Directive §PR-1.5) — the portal-actor consent path end-to-end
// against a real Postgres 17, at the service level (no AppModule boot; the portal
// HTTP membership gate is covered by the pact + the negative-shape 404). Proves:
// grant → state active → revoke → state inactive; the read-derived 12-month term
// (expiry via clock control on grantAsPortal's `now`); idempotent revoke; the D7
// evidence object on the audit stream; and the tenant-actor path unchanged
// (byte-identical: a null-expiry recruiter grant is never derived expired).

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
].map((p) => resolve(ROOT, p));

const TENANT = '11111111-1111-7111-8111-111111111111';
const PORTAL_USER = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const RECRUITER = 'dddddddd-dddd-7ddd-8ddd-ddddddddddd1';
const RECORD = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee1';
const RECORD2 = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee2';

let keyCounter = 0;
const nextKey = (): string =>
  `cccccccc-cccc-7ccc-8ccc-${String(++keyCounter).padStart(12, '0')}`;

function portalAuth() {
  return {
    sub: PORTAL_USER,
    consumer_type: 'portal' as const,
    actor_kind: 'user' as const,
    tenant_id: TENANT, // record-tenant-scoped by the controller
    scopes: ['portal:consent:write'],
    iat: 0,
    exp: 0,
  };
}
function recruiterAuth() {
  return {
    sub: RECRUITER,
    consumer_type: 'recruiter' as const,
    actor_kind: 'user' as const,
    tenant_id: TENANT,
    scopes: [],
    iat: 0,
    exp: 0,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Portal P2 P2a — portal-actor consent (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let service: ConsentService;
    const savedEnv: Partial<Record<string, string | undefined>> = {};

    const statusOf = async (record: string, scope: string): Promise<string> => {
      const state = await service.getState(record, portalAuth(), 'req');
      return state.scopes.find((s) => s.scope === scope)!.status;
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      process.env['DATABASE_URL'] = url;
      prisma = new PrismaService(url);
      await prisma.$connect();
      service = new ConsentService(new ConsentRepository(prisma));
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      await db.query(`TRUNCATE TABLE consent."TalentConsentEvent" CASCADE`);
      await db.query(`TRUNCATE TABLE consent."IdempotencyKey" CASCADE`);
      await db.query(`TRUNCATE TABLE consent."OutboxEvent" CASCADE`);
      await db.query(`TRUNCATE TABLE audit."ConsentAuditEvent" CASCADE`);
    });

    it('grant → state active → revoke → state inactive (the full circle)', async () => {
      await service.grantAsPortal({
        talent_record_id: RECORD,
        scope: 'matching',
        authContext: portalAuth(),
        idempotencyKey: nextKey(),
        requestId: 'r',
      });
      expect(await statusOf(RECORD, 'matching')).toBe('granted');

      await service.revokeAsPortal({
        talent_record_id: RECORD,
        scope: 'matching',
        authContext: portalAuth(),
        idempotencyKey: nextKey(),
        requestId: 'r',
      });
      expect(await statusOf(RECORD, 'matching')).toBe('revoked');
    });

    it('read-derived term: a grant past its 12-month expiry is derived EXPIRED', async () => {
      // Clock control: grant 13 months ago → expires_at = 1 month ago.
      const thirteenMonthsAgo = new Date();
      thirteenMonthsAgo.setMonth(thirteenMonthsAgo.getMonth() - 13);
      await service.grantAsPortal({
        talent_record_id: RECORD,
        scope: 'contacting',
        authContext: portalAuth(),
        idempotencyKey: nextKey(),
        requestId: 'r',
        now: thirteenMonthsAgo,
      });
      // Still the latest grant, but its term has passed → derived expired.
      expect(await statusOf(RECORD, 'contacting')).toBe('expired');
    });

    it('revocation is idempotent — revoking a never-granted scope is a no-op success', async () => {
      // No prior grant; revoke must not throw and leaves the scope inactive.
      await expect(
        service.revokeAsPortal({
          talent_record_id: RECORD,
          scope: 'profile_storage',
          authContext: portalAuth(),
          idempotencyKey: nextKey(),
          requestId: 'r',
        }),
      ).resolves.toMatchObject({ action: 'revoked' });
      expect(await statusOf(RECORD, 'profile_storage')).toBe('revoked');
    });

    it('records the D7 consent-evidence object on the audit stream (grant AND revoke)', async () => {
      await service.grantAsPortal({
        talent_record_id: RECORD,
        scope: 'resume_processing',
        authContext: portalAuth(),
        idempotencyKey: nextKey(),
        requestId: 'r',
      });
      const rows = await db.query<{ actor_type: string; event_payload: { consent_evidence?: { channel: string; consent_text_hash: string; notice_version: string | null } } }>(
        `SELECT actor_type, event_payload FROM audit."ConsentAuditEvent"
          WHERE subject_id = $1::uuid AND event_type = 'consent.grant.recorded'`,
        [RECORD],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.actor_type).toBe('self'); // portal is self-directed
      const ev = rows.rows[0]!.event_payload.consent_evidence!;
      expect(ev.channel).toBe('portal');
      expect(ev.notice_version).toBeNull(); // P4 forward contract
      expect(ev.consent_text_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    });

    it('tenant-actor path is byte-identical — a null-expiry recruiter grant stays GRANTED (never derived expired)', async () => {
      await service.grant(
        {
          talent_record_id: RECORD2,
          scope: 'matching',
          captured_method: 'recruiter_capture',
          consent_version: 'v1',
          occurred_at: new Date().toISOString(),
          // NO expires_at — the tenant recruiter path is unchanged.
        } as never,
        nextKey(),
        recruiterAuth(),
        'r',
      );
      const state = await service.getState(RECORD2, recruiterAuth(), 'r');
      expect(state.scopes.find((s) => s.scope === 'matching')!.status).toBe('granted');
      // The recruiter grant recorded actor_type 'recruiter' (unchanged derivation).
      const audit = await db.query<{ actor_type: string }>(
        `SELECT actor_type FROM audit."ConsentAuditEvent" WHERE subject_id = $1::uuid`,
        [RECORD2],
      );
      expect(audit.rows[0]!.actor_type).toBe('recruiter');
    });
  },
);
