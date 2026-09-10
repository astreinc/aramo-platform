import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import { IngestionModule } from '@aramo/ingestion';
import { ObjectStorageService } from '@aramo/object-storage';
import { SourcedTalentModule } from '@aramo/sourced-talent';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ManualTalentCaptureService } from '../manual-capture/manual-capture.service.js';

// TM-L1-C1 — manual recruiter capture, end-to-end against real Postgres. Proves
// the governed staging outcome (RawPayloadReference + SourcedTalent), the
// provenance envelope, deterministic replay/idempotency, tenant isolation, and —
// the load-bearing invariant — ZERO TalentRecord rows (Arrival != Talent).

const ROOT = resolve(__dirname, '../../../..');

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
    .map((d) => d.name)
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

const MIGRATIONS = [
  ...migrationsFor('ingestion'),
  ...migrationsFor('sourced-talent'),
  ...migrationsFor('talent-record'),
];

// $$-aware DDL splitter (mirrors the sourced-talent / indeed harness) — the
// immutability trigger bodies are delimited by $$.
function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < noLineComments.length; i += 1) {
    if (noLineComments.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    const ch = noLineComments[i]!;
    if (ch === ';' && !inDollar) {
      const t = current.trim();
      if (t.length > 0) out.push(t);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

const fakeStorage = {
  putIngestionObject: async (input: {
    tenant_id: string;
    channel: string;
    external_source_id: string;
    body: Buffer;
    content_type: string;
    requestId: string;
  }): Promise<{ storage_ref: string; sha256: string }> => {
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    const key = `${input.tenant_id}/ingestion/${input.channel}/${input.external_source_id}.json`;
    return { storage_ref: key, sha256 };
  },
};

const FIELDS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'Ada@Example.com',
  phone: '+1 555 010 2030',
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TM-L1-C1 — manual recruiter capture (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let moduleRef: TestingModule;
    let service: ManualTalentCaptureService;
    let db: Client;
    let savedDbUrl: string | undefined;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new Client({ connectionString: url });
      await setup.connect();
      for (const p of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          await setup.query(stmt);
        }
      }
      await setup.end();

      savedDbUrl = process.env['DATABASE_URL'];
      process.env['DATABASE_URL'] = url;

      moduleRef = await Test.createTestingModule({
        imports: [IngestionModule, SourcedTalentModule],
        providers: [
          ManualTalentCaptureService,
          { provide: ObjectStorageService, useValue: fakeStorage },
        ],
      }).compile();

      service = moduleRef.get(ManualTalentCaptureService);

      db = new Client({ connectionString: url });
      await db.connect();
    }, 180_000);

    afterAll(async () => {
      await moduleRef?.close();
      await db?.end();
      await container?.stop();
      if (savedDbUrl === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = savedDbUrl;
    }, 60_000);

    async function rawCount(tenantId: string): Promise<number> {
      const r = await db.query(
        `SELECT COUNT(*)::int AS c FROM "ingestion"."RawPayloadReference" WHERE tenant_id = $1`,
        [tenantId],
      );
      return r.rows[0].c;
    }
    async function stagingCount(tenantId: string): Promise<number> {
      const r = await db.query(
        `SELECT COUNT(*)::int AS c FROM "sourced_talent"."SourcedTalent" WHERE tenant_id = $1`,
        [tenantId],
      );
      return r.rows[0].c;
    }
    async function talentRecordCount(tenantId: string): Promise<number> {
      const r = await db.query(
        `SELECT COUNT(*)::int AS c FROM "talent_record"."TalentRecord" WHERE tenant_id = $1`,
        [tenantId],
      );
      return r.rows[0].c;
    }

    it('creates a talent_direct/SELF RawPayloadReference + a TALENT_DIRECT staging subject, and ZERO TalentRecord rows', async () => {
      const tenant = uuidv7();
      const actor = uuidv7();
      const result = await service.capture({
        tenant_id: tenant,
        actor_id: actor,
        requestId: uuidv7(),
        fields: FIELDS,
      });

      expect(result.source).toBe('talent_direct');
      expect(result.source_class).toBe('SELF');

      // Provenance envelope on the arrival.
      const raw = await db.query(
        `SELECT source, source_class, storage_ref, sha256, content_type, captured_at
         FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
        [result.ingestion_payload_id],
      );
      expect(raw.rows).toHaveLength(1);
      expect(raw.rows[0].source).toBe('talent_direct');
      expect(raw.rows[0].source_class).toBe('SELF'); // server-derived
      expect(raw.rows[0].content_type).toBe('application/json');
      expect(raw.rows[0].storage_ref.length).toBeGreaterThan(0);
      expect(raw.rows[0].sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(raw.rows[0].captured_at).not.toBeNull();

      // Pre-Talent staging subject with actor in provenance (⊥ source/channel).
      const st = await db.query(
        `SELECT source_channel, external_source_id, normalized_email, provenance, legal_basis
         FROM "sourced_talent"."SourcedTalent" WHERE id = $1`,
        [result.arrival_id],
      );
      expect(st.rows).toHaveLength(1);
      expect(st.rows[0].source_channel).toBe('TALENT_DIRECT');
      expect(st.rows[0].external_source_id).toBe(raw.rows[0].sha256);
      expect(st.rows[0].normalized_email).toBe('ada@example.com');
      expect(st.rows[0].provenance.captured_by_actor_id).toBe(actor);
      // FIX_NOW — no fabricated legal basis persisted: basis unasserted + pending
      // counsel. recruiter_manual_entry is capture-mechanism provenance only.
      expect(st.rows[0].legal_basis.basis).toBeNull();
      expect(st.rows[0].legal_basis.status).toBe('PENDING_COUNSEL');
      expect(st.rows[0].provenance.capture_mechanism).toBe('recruiter_manual_entry');
      expect(JSON.stringify(st.rows[0].legal_basis)).not.toContain('recruiter_manual_entry');

      // The load-bearing negative: manual capture minted NO genuine Talent.
      expect(await talentRecordCount(tenant)).toBe(0);
      expect(await rawCount(tenant)).toBe(1);
      expect(await stagingCount(tenant)).toBe(1);
    });

    it('is idempotent on replay of identical structured input (same ids; one row each; provenance preserved)', async () => {
      const tenant = uuidv7();
      const first = await service.capture({
        tenant_id: tenant,
        actor_id: uuidv7(),
        requestId: uuidv7(),
        fields: FIELDS,
      });
      const firstCapturedAt = (
        await db.query(
          `SELECT captured_at FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
          [first.ingestion_payload_id],
        )
      ).rows[0].captured_at;

      // A different actor + requestId, identical person fields → same content.
      const second = await service.capture({
        tenant_id: tenant,
        actor_id: uuidv7(),
        requestId: uuidv7(),
        fields: FIELDS,
      });

      expect(second.ingestion_payload_id).toBe(first.ingestion_payload_id);
      expect(second.arrival_id).toBe(first.arrival_id);
      expect(await rawCount(tenant)).toBe(1);
      expect(await stagingCount(tenant)).toBe(1);
      // captured_at from the first capture is preserved (dedup short-circuits).
      const afterCapturedAt = (
        await db.query(
          `SELECT captured_at FROM "ingestion"."RawPayloadReference" WHERE id = $1`,
          [first.ingestion_payload_id],
        )
      ).rows[0].captured_at;
      expect(afterCapturedAt.toISOString()).toBe(firstCapturedAt.toISOString());
      expect(await talentRecordCount(tenant)).toBe(0);
    });

    it('is tenant-isolated — identical fields in a different tenant produce distinct arrivals', async () => {
      const tenantA = uuidv7();
      const tenantB = uuidv7();
      const a = await service.capture({ tenant_id: tenantA, actor_id: uuidv7(), requestId: uuidv7(), fields: FIELDS });
      const b = await service.capture({ tenant_id: tenantB, actor_id: uuidv7(), requestId: uuidv7(), fields: FIELDS });
      expect(b.ingestion_payload_id).not.toBe(a.ingestion_payload_id);
      expect(b.arrival_id).not.toBe(a.arrival_id);
      expect(await rawCount(tenantA)).toBe(1);
      expect(await rawCount(tenantB)).toBe(1);
    });
  },
);
