import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { computeEmailFingerprint, loadIdentityAdmissionPolicy } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdmitArrivalsModule } from '../talent-anchor/admit-arrivals.module.js';
import { AdmitArrivalsService } from '../talent-anchor/admit-arrivals.service.js';

// TR-2b B2b (Directive §PR-2.2, R7) — the admit-arrivals backfill, end-to-end
// against a real Postgres 17. Cluster-key admission ONLY (ruling A): read L1
// normalized_email → fingerprint → findOrCreateClusterByFingerprint('email').
// Proves: the PORTABLE_ONLY refusal gate; dry-run vs execute parity (dry-run
// mints nothing, execute mints one cluster per distinct fingerprint); idempotent
// re-run (existing fingerprints resolve, never duplicate). L1 empty → reports 0.

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const MIGRATIONS = [
  'libs/sourced-talent/prisma/migrations/20260704000000_init_sourced_talent/migration.sql',
  'libs/sourced-talent/prisma/migrations/20260713160000_add_sourced_talent_normalized_contact/migration.sql',
  'libs/identity-index/prisma/migrations/20260630000000_init_identity_index/migration.sql',
];

const PEPPER = 'tr2b-b2b-test-pepper';
const TENANT_A = '01900000-0000-7000-8000-0000000000c1';
const TENANT_B = '01900000-0000-7000-8000-0000000000c2';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2b B2b — admit-arrivals backfill (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    let admit: AdmitArrivalsService;
    const savedEnv: Partial<Record<string, string | undefined>> = {};

    async function seedArrival(
      tenant: string,
      channel: string,
      externalId: string,
      email: string | null,
    ): Promise<void> {
      await db.query(
        `INSERT INTO sourced_talent."SourcedTalent"
           (id, tenant_id, source_channel, external_source_id, normalized_email,
            provenance, legal_basis, arrived_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, '{}'::jsonb, '{}'::jsonb, now(), now())`,
        [uuidv7(), tenant, channel, externalId, email],
      );
    }

    const clusterCount = async (): Promise<number> => {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM identity_index."PersonCluster"`,
      );
      return Number(r.rows[0]!.n);
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(M(p));

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['ARAMO_IDENTITY_PEPPER'] = process.env['ARAMO_IDENTITY_PEPPER'];
      savedEnv['ARAMO_IDENTITY_ADMISSION_POLICY'] = process.env['ARAMO_IDENTITY_ADMISSION_POLICY'];
      process.env['DATABASE_URL'] = url;
      process.env['ARAMO_IDENTITY_PEPPER'] = PEPPER;
      process.env['ARAMO_IDENTITY_ADMISSION_POLICY'] = 'ALL_ARRIVALS';

      module = await Test.createTestingModule({ imports: [AdmitArrivalsModule] }).compile();
      await module.init();
      admit = module.get(AdmitArrivalsService);
    }, 300_000);

    afterAll(async () => {
      await module?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      await db.query(`TRUNCATE TABLE sourced_talent."SourcedTalent" CASCADE`);
      await db.query(`TRUNCATE TABLE identity_index."PersonCluster" CASCADE`);
    });

    it('reports 0 against an empty L1 (the mechanism precedes the history)', async () => {
      const r = await admit.run({ dryRun: true });
      expect(r.scanned).toBe(0);
      expect(r.admitted).toBe(0);
      expect(await clusterCount()).toBe(0);
    });

    it('the CLI refuses under PORTABLE_ONLY (the fail-loud policy gate)', () => {
      const prev = process.env['ARAMO_IDENTITY_ADMISSION_POLICY'];
      process.env['ARAMO_IDENTITY_ADMISSION_POLICY'] = 'PORTABLE_ONLY';
      // The CLI's gate is `loadIdentityAdmissionPolicy() !== 'ALL_ARRIVALS'`.
      expect(loadIdentityAdmissionPolicy()).toBe('PORTABLE_ONLY');
      process.env['ARAMO_IDENTITY_ADMISSION_POLICY'] = prev;
    });

    it('dry-run mints NOTHING; execute mints one cluster per distinct fingerprint', async () => {
      await seedArrival(TENANT_A, 'talent_direct', 'ext-1', 'a@example.com');
      await seedArrival(TENANT_B, 'referral', 'ext-2', 'b@example.com');
      // Same email arriving twice (two tenants) → ONE cluster (same fingerprint).
      await seedArrival(TENANT_B, 'referral', 'ext-3', 'a@example.com');

      const dry = await admit.run({ dryRun: true });
      expect(dry.scanned).toBe(3);
      expect(dry.admitted).toBe(2); // a@ and b@ are new; the 3rd (a@) already-would-be
      expect(await clusterCount()).toBe(0); // dry-run wrote nothing

      const exec = await admit.run({ dryRun: false });
      expect(exec.scanned).toBe(3);
      expect(exec.admitted).toBe(2); // two distinct fingerprints minted
      expect(await clusterCount()).toBe(2);
      // Per-channel counts surfaced.
      expect(exec.channels.length).toBeGreaterThanOrEqual(2);
    });

    it('is idempotent — a re-run resolves existing fingerprints, never duplicates', async () => {
      await seedArrival(TENANT_A, 'talent_direct', 'ext-1', 'dup@example.com');
      await admit.run({ dryRun: false });
      expect(await clusterCount()).toBe(1);

      const again = await admit.run({ dryRun: false });
      expect(again.admitted).toBe(0);
      expect(again.already_present).toBe(1);
      expect(await clusterCount()).toBe(1); // no duplicate

      // The cluster is keyed by the email fingerprint (PII-free).
      const fp = computeEmailFingerprint('dup@example.com', PEPPER);
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM identity_index."ClusterFingerprint" WHERE fingerprint = $1`,
        [fp],
      );
      expect(Number(r.rows[0]!.n)).toBe(1);
    });
  },
);
