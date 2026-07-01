import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Client } from 'pg';

// 4e-engagement-key — shared integration-test fixtures for the TalentRecord
// substrate. engagement.talent_id now references talent_record.TalentRecord.id
// (the ATS heart), so every spec that creates an engagement must (a) migrate
// the talent_record schema and (b) seed a TalentRecord the create validator
// resolves against. Centralised here so the migration set + seed shape live in
// ONE place instead of being copy-pasted (and drifting) across ~10 specs.

const ROOT = resolve(__dirname, '../../../..');

// The 5 COLUMN-adding talent-record migrations. The Prisma client projects
// every scalar column on findFirst, so the table must carry them all (init +
// the additive columns). The trgm / résumé-text / search-index migrations add
// no TalentRecord scalar columns and are intentionally omitted.
const TALENT_RECORD_MIGRATION_PATHS = [
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
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

// Seed a TalentRecord the engagement-create Pattern-C validator
// (TalentRecordRepository.findById) resolves against. `id` is the value that
// goes into engagement.talent_id; tenant-scoped.
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
