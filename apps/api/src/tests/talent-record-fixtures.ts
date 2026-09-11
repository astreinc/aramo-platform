import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from 'pg';

// 4e-selection-key — shared integration-test fixtures for the TalentRecord
// substrate. selection.talent_id now references talent_record.TalentRecord.id
// (the ATS heart), so every spec that creates an selection must (a) migrate
// the talent_record schema and (b) seed a TalentRecord the create validator
// resolves against. Centralised here so the migration set + seed shape live in
// ONE place instead of being copy-pasted (and drifting) across ~10 specs.

const ROOT = resolve(__dirname, '../../../..');

// The COLUMN-mutating talent-record migrations. The Prisma client projects
// every scalar column on findFirst, so the table must match the client (init +
// the additive columns, minus the 4e-rest identity-link column drop). The trgm /
// résumé-text / search-index migrations add no TalentRecord scalar columns and
// are intentionally omitted.
const TALENT_RECORD_MIGRATION_PATHS = [
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
  // 4e-rest — drops the retired identity-link column (must run last so the test
  // schema matches the regenerated Prisma client, which no longer projects it).
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
  // Gate-1 G1-A — adds work_authorization (the regenerated client projects it;
  // the test schema must carry it or findFirst 500s).
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
  // B1+B2 — adds title + country (the regenerated client projects both; the
  // test schema must carry them or findFirst 500s).
  'libs/talent-record/prisma/migrations/20260910130000_add_talent_title_and_country/migration.sql',
].map((p) => resolve(ROOT, p));

// Apply the talent_record schema to a test database. Feeds each whole
// migration file to `pg.Client.query`, which parses multi-statement SQL and
// `--` line comments natively — so we avoid the fragile per-statement
// splitters that choke on the `;`-inside-a-comment in the stated-fields
// migration. talent_record has no cross-schema FK (UUID-only refs per §7.3),
// so call order relative to other schemas is irrelevant.
export async function applyTalentRecordMigrations(client: Client): Promise<void> {
  for (const path of TALENT_RECORD_MIGRATION_PATHS) {
    await client.query(readFileSync(path, 'utf8'));
  }
}

// TalentRecord Admission Invariant — a valid `POST /v1/talent-records` body.
// Since the admission invariant (email1 + phone_cell required) now gates the
// manual-create path, every HTTP create in the integration suite must supply
// the contact anchors. This helper is the ONE place that knows what a valid
// create body looks like: callers pass only the fields they assert on
// (first_name / last_name / site_id / etc.) and get distinct, valid email +
// cell phone by default (a per-file monotonic counter keeps successive creates
// dedup-safe — the 409 duplicate-email guard). Pass email1/phone_cell
// explicitly to exercise the duplicate / missing-field paths on purpose.
let talentCreateSeq = 0;
export function validTalentCreateBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  talentCreateSeq += 1;
  const n = talentCreateSeq;
  return {
    first_name: 'Valid',
    last_name: `Talent${n}`,
    email1: `valid.talent.${n}@example.test`,
    phone_cell: `+1512555${String(1000 + (n % 9000)).padStart(4, '0')}`,
    ...overrides,
  };
}

// Seed a TalentRecord the selection-create Pattern-C validator
// (TalentRecordRepository.findById) resolves against. `id` is the value that
// goes into selection.talent_id; tenant-scoped.
export async function seedTalentRecord(
  client: Client,
  opts: { id: string; tenant_id: string; first_name?: string; last_name?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO talent_record."TalentRecord"
       (id, tenant_id, first_name, last_name, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (id) DO NOTHING`,
    [opts.id, opts.tenant_id, opts.first_name ?? 'Pact', opts.last_name ?? 'Talent'],
  );
}
