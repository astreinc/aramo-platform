import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// SW-1 remediation — shared test fixture for HTTP-create specs.
//
// SW-1 (R1-A) made POST /v1/submittals derive the authoritative pipeline_id from
// the sole LIVE Pipeline episode, so a valid client-submittal create now requires a
// live Pipeline episode for the Talent × requisition. Specs that boot AppModule and
// POST a real create must therefore provision the Pipeline schema + a live episode
// (fix the fixture, not the product invariant — the live-Pipeline requirement is NOT
// bypassed or mocked). ONE shared helper rather than N duplicated edits across the
// affected specs.
//
// The paths resolve against the repo ROOT. Specs pass the whole migration file to
// node-pg's simple-query (dollar-quote aware), so no DDL splitter is needed here.

export function pipelineMigrationPaths(root: string): string[] {
  return [
    // Pipeline schema ONLY (self-contained — the migrations reference activity/metering
    // in comments, never in DDL, so no activity/metering tables are required at apply
    // time; this avoids clashing with specs that already provision those schemas).
    // init -> live-episode index -> version -> L2-B/-C/-D -> canonical 7-state -> VOID
    // enum + index. Creates Pipeline with the PipelineStatus enum carrying the live
    // ('qualifying') + terminal ('voided' etc.) labels findLiveEpisode reads.
    'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
    'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
    'libs/pipeline/prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
    'libs/pipeline/prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
    'libs/pipeline/prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
    'libs/pipeline/prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
    'libs/pipeline/prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
    'libs/pipeline/prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
    'libs/pipeline/prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
    'libs/pipeline/prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
    'libs/pipeline/prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
    'libs/pipeline/prisma/migrations/20260925120000_pipeline_void_add_enum_value/migration.sql',
    'libs/pipeline/prisma/migrations/20260925120100_pipeline_void_live_index_recreate/migration.sql',
  ].map((p) => resolve(root, p));
}

// Apply the Pipeline (+ activity/metering) schema via a node-pg-style query fn.
export async function applyPipelineSchema(
  query: (sql: string) => Promise<unknown>,
  root: string,
): Promise<void> {
  for (const p of pipelineMigrationPaths(root)) {
    await query(readFileSync(p, 'utf8'));
  }
}

// Seed a single LIVE Pipeline episode for the (tenant, talent, requisition) triple
// the create request keys on, so the SW-1 server-side derivation resolves it and the
// create succeeds. Returns the episode id.
export async function seedLivePipelineEpisode(
  query: (sql: string, params: unknown[]) => Promise<unknown>,
  args: { tenant_id: string; talent_record_id: string; requisition_id: string; status?: string },
): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status)
     VALUES ($1, $2, $3, $4, $5::pipeline."PipelineStatus")`,
    [id, args.tenant_id, args.talent_record_id, args.requisition_id, args.status ?? 'qualifying'],
  );
  return id;
}
