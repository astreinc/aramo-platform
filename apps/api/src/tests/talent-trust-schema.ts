import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// INC-1b (TIP-E2E) test fixture — apply the talent_trust schema for integration specs
// that create submittals. The global TalentAnchorInterceptor (ADR-0033 talent-anchor,
// merged from main) writes talent_trust.ResolutionSubjectRef on talent-record / submittal
// mutations; without the schema, POST /v1/submittals 500s in setup. The examine
// integration specs already migrate talent_trust inline — this is the shared equivalent
// for the submittal negative-shape specs.
//
// NOTE: explicit, hardcoded migration list applied with readFileSync (NOT readdirSync) —
// identical mechanism to the passing examine specs + the sibling ensureAtsEntitlement
// helper. (An earlier readdirSync-based glob applied nothing under the CI integration
// runner despite working locally; the explicit-path + readFileSync form is the proven one.)
// Kept in timestamp order, matching examine-live-list.integration.spec.ts lines 120-138.
const TALENT_TRUST_MIGRATIONS: ReadonlyArray<string> = [
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
];

export async function applyTalentTrustSchema(
  query: (sql: string) => Promise<unknown>,
  root: string,
): Promise<void> {
  for (const rel of TALENT_TRUST_MIGRATIONS) {
    await query(readFileSync(resolve(root, rel), 'utf8'));
  }
}
