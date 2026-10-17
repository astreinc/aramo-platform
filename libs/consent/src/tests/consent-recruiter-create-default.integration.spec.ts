import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConsentRepository } from '../lib/consent.repository.js';
import { ConsentService } from '../lib/consent.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// CONSENT-RECRUITER-CREATE-DEFAULT-1 (Amendment v1.0 LOCKED §9) — the at-create
// default end-to-end against a real Postgres 17 at the service level: the ledger
// row shape (§9.5), the send gates allow email + phone (§9.1), SMS stays denied
// (§9.6), a later revocation denies contact (§9.4), and a replay writes nothing.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
].map((p) => resolve(ROOT, p));

const TENANT = '11111111-1111-7111-8111-111111111111';
const RECRUITER = 'dddddddd-dddd-7ddd-8ddd-ddddddddddd1';
const RECORD = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee1';
const NOW = new Date('2026-10-16T12:00:00.000Z');

const recruiterAuth = (): AuthContextType =>
  ({
    sub: RECRUITER,
    consumer_type: 'recruiter',
    actor_kind: 'user',
    tenant_id: TENANT,
    scopes: [],
    iat: 0,
    exp: 0,
  }) as unknown as AuthContextType;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'CONSENT-RECRUITER-CREATE-DEFAULT-1 — at-create default (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let service: ConsentService;
    const savedEnv: Partial<Record<string, string | undefined>> = {};

    const check = (operation: 'communication' | 'submittal', channel: string) =>
      service.check(
        { talent_record_id: RECORD, operation, channel } as never,
        undefined as unknown as string,
        recruiterAuth(),
        'req',
      );

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
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

    it('§9.5 — ledger rows: method, text version + hash, recruiter actor, channels, 12-month expiry', async () => {
      const out = await service.recordRecruiterCreateDefault({
        talent_record_id: RECORD,
        authContext: recruiterAuth(),
        requestId: 'r1',
        now: NOW,
      });
      expect(out.status).toBe('recorded');

      const rows = await db.query(
        `SELECT scope, action, captured_method, captured_by_actor_id, consent_version,
                consent_text_snapshot, metadata, expires_at
           FROM consent."TalentConsentEvent" WHERE talent_record_id = $1 ORDER BY occurred_at, scope`,
        [RECORD],
      );
      expect(rows.rows.map((r) => r.scope).sort()).toEqual(['contacting', 'matching', 'profile_storage']);
      for (const r of rows.rows) {
        expect(r.action).toBe('granted');
        expect(r.captured_method).toBe('recruiter_create_default');
        expect(r.captured_by_actor_id).toBe(RECRUITER);
        expect(r.consent_version).toBe('recruiter-create-default-v1');
        expect((r.expires_at as Date).toISOString()).toBe('2027-10-16T12:00:00.000Z');
      }
      const contacting = rows.rows.find((r) => r.scope === 'contacting');
      expect(contacting.metadata).toEqual({ permitted_channels: ['email', 'phone'] });

      const audits = await db.query(
        `SELECT actor_type, actor_id, event_payload FROM audit."ConsentAuditEvent"
          WHERE subject_id = $1 AND event_type = 'consent.grant.recorded'`,
        [RECORD],
      );
      expect(audits.rows).toHaveLength(3);
      const expectedHash = createHash('sha256')
        .update(contacting.consent_text_snapshot as string, 'utf8')
        .digest('hex');
      for (const a of audits.rows) {
        expect(a.actor_type).toBe('recruiter');
        expect(a.actor_id).toBe(RECRUITER);
        expect(a.event_payload.consent_evidence).toMatchObject({
          consent_text_version: 'recruiter-create-default-v1',
          consent_text_hash: expectedHash,
          channel: 'recruiter_create_default',
        });
      }
      const outbox = await db.query(`SELECT count(*)::int AS n FROM consent."OutboxEvent"`);
      expect(outbox.rows[0].n).toBe(3);
    });

    it('§9.1/§9.6 — email + phone allowed; SMS denied', async () => {
      await service.recordRecruiterCreateDefault({
        talent_record_id: RECORD,
        authContext: recruiterAuth(),
        requestId: 'r2',
      });
      expect((await check('communication', 'email')).result).toBe('allowed');
      expect((await check('communication', 'phone')).result).toBe('allowed');
      const sms = await check('communication', 'sms');
      expect(sms.result).toBe('denied');
      expect(sms.reason_code).toBe('channel_not_consented');
    });

    it('§9.4 — a later recruiter revocation of contacting denies contact', async () => {
      await service.recordRecruiterCreateDefault({
        talent_record_id: RECORD,
        authContext: recruiterAuth(),
        requestId: 'r3',
      });
      await service.revoke(
        {
          talent_record_id: RECORD,
          scope: 'contacting',
          captured_method: 'recruiter_capture',
          consent_version: 'recruiter-capture-v1-draft',
          occurred_at: new Date(Date.now() + 1000).toISOString(),
        } as never,
        'revoke-key-1',
        recruiterAuth(),
        'r3b',
      );
      const after = await check('communication', 'email');
      expect(after.result).toBe('denied');
      expect(after.reason_code).toBe('consent_revoked');
    });

    it('§4 — replay / non-empty ledger writes nothing further', async () => {
      await service.recordRecruiterCreateDefault({
        talent_record_id: RECORD,
        authContext: recruiterAuth(),
        requestId: 'r4',
      });
      const second = await service.recordRecruiterCreateDefault({
        talent_record_id: RECORD,
        authContext: recruiterAuth(),
        requestId: 'r4b',
      });
      expect(second).toEqual({ status: 'skipped', reason: 'consent_ledger_not_empty' });
      const n = await db.query(`SELECT count(*)::int AS n FROM consent."TalentConsentEvent"`);
      expect(n.rows[0].n).toBe(3);
    });
  },
);
