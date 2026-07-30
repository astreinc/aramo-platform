import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Decision } from '@aramo/policy-engine';

import { PolicyDecisionRecordStore, type RecordPolicyDecisionInput } from '../lib/decision-record-store.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import type { PolicyDecisionInputs } from '../lib/decision-inputs.js';

// PR-2b integration test (ADR-0024 §D17a). Applies every policy_store
// migration in order, then proves the append-only decision-provenance store:
// all four decision kinds persist (incl DENY), the `__default__` no-match
// marker round-trips, tenant isolation holds, a correlation id groups one
// command's records, and there is no update/delete surface.

const MIGRATIONS_DIR = resolve(__dirname, '../../prisma/migrations');

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const ACTOR = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

const INPUTS: PolicyDecisionInputs = {
  resource: 'DOC',
  action: 'WRITE',
  declared: { status: 'active' },
  derived: { is_hot: false },
  capabilities: { 'pipeline:add': true },
};

function makeInput(over: Partial<RecordPolicyDecisionInput> = {}): RecordPolicyDecisionInput {
  return {
    tenant_id: TENANT_A,
    decision: 'ALLOW',
    policy_version: '1.0.0',
    rule_id: 'r1',
    reason_code: 'OK',
    resource: 'DOC',
    action: 'WRITE',
    inputs: INPUTS,
    actor_id: ACTOR,
    origin: 'ui',
    correlation_id: 'corr-1',
    ...over,
  };
}

// Apply every migration.sql, directory-name (timestamp) ordered.
async function applyMigrations(exec: (sql: string) => Promise<unknown>): Promise<void> {
  const dirs = readdirSync(MIGRATIONS_DIR).filter((d) => !d.startsWith('.')).sort();
  for (const dir of dirs) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
    for (const stmt of sql.split(';')) {
      const trimmed = stmt.trim();
      if (trimmed.length === 0) continue;
      await exec(trimmed);
    }
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'PolicyDecisionRecordStore — §D17a provenance integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let store: PolicyDecisionRecordStore;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new PrismaService(url);
      await setup.$connect();
      await applyMigrations((sql) => setup.$executeRawUnsafe(sql));
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "policy_store"."PolicyDecisionRecord"');
      store = new PolicyDecisionRecordStore(prisma);
    });

    it('persists all four decision kinds, including DENY', async () => {
      const kinds: Decision[] = ['ALLOW', 'DENY', 'REQUIRES_OVERRIDE', 'ALLOW_WITH_AUDIT'];
      for (const decision of kinds) {
        await store.record(makeInput({ decision, reason_code: `RC_${decision}` }));
      }
      const all = await store.listByTenant(TENANT_A);
      expect(all.map((r) => r.decision).sort()).toEqual([...kinds].sort());
      // The DENY specifically is present and readable.
      expect(all.some((r) => r.decision === 'DENY')).toBe(true);
    });

    it('round-trips the __default__ no-match provenance marker', async () => {
      const rec = await store.record(makeInput({ decision: 'ALLOW', rule_id: '__default__', reason_code: 'DEFAULT_ALLOW' }));
      const read = await store.getById(TENANT_A, rec.id);
      expect(read?.rule_id).toBe('__default__');
      expect(read?.policy_version).toBe('1.0.0');
    });

    it('round-trips the PII-free inputs snapshot verbatim', async () => {
      const rec = await store.record(makeInput());
      const read = await store.getById(TENANT_A, rec.id);
      expect(read?.inputs).toEqual(INPUTS);
    });

    it('isolates records by tenant', async () => {
      const a = await store.record(makeInput({ tenant_id: TENANT_A }));
      await store.record(makeInput({ tenant_id: TENANT_B }));

      expect(await store.listByTenant(TENANT_A)).toHaveLength(1);
      expect(await store.listByTenant(TENANT_B)).toHaveLength(1);
      // A record is not readable from the other tenant.
      expect(await store.getById(TENANT_B, a.id)).toBeNull();
    });

    it('groups one command\'s records by correlation id', async () => {
      await store.record(makeInput({ correlation_id: 'cmd-1', rule_id: 'r1' }));
      await store.record(makeInput({ correlation_id: 'cmd-1', rule_id: 'r2' }));
      await store.record(makeInput({ correlation_id: 'cmd-2', rule_id: 'r3' }));

      const cmd1 = await store.listByCorrelation(TENANT_A, 'cmd-1');
      expect(cmd1).toHaveLength(2);
      expect(cmd1.every((r) => r.correlation_id === 'cmd-1')).toBe(true);
      expect(await store.listByCorrelation(TENANT_A, 'cmd-2')).toHaveLength(1);
    });

    it('exposes NO update or delete surface (append-only)', () => {
      const surface = store as unknown as Record<string, unknown>;
      for (const forbidden of ['update', 'delete', 'remove', 'upsert', 'deleteMany', 'updateMany']) {
        expect(surface[forbidden]).toBeUndefined();
      }
      expect(typeof store.record).toBe('function');
    });
  },
);
