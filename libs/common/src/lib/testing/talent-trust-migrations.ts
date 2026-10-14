import { resolve } from 'node:path';

// Shared talent-trust migration-registration helper (G1 — Aramo-G1-TrustState-
// Recompute-Ordering-and-Recovery-Directive-v1_0-LOCKED §5; the identity-
// migrations.ts precedent). 19 integration specs hand-listed the libs/talent-trust
// migration set, most of them a stale prefix. G1 adds a column Prisma SELECTs on
// every ResolutionSubject read, so every talent-trust-backed spec needs the FULL
// set: this module is its single ordered source of truth — the NEXT talent-trust
// migration is a ONE-LINE edit HERE, not a 19-site sweep.
//
// ── APPLY order = timestamp order. ───────────────────────────────────────────
// The talent-trust migrations are additive and self-contained in the
// talent_trust schema (no cross-schema FK), so the fresh-DB timestamp order is the
// apply order. Append the next migration at the end.

// The full libs/talent-trust migration set, in APPLY order. Paths are
// repo-root-relative; consumers resolve them against their own repo root.
export const TALENT_TRUST_MIGRATIONS: readonly string[] = [
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
  'libs/talent-trust/prisma/migrations/20260715120000_p3a_portal_dispute_substrate/migration.sql',
  'libs/talent-trust/prisma/migrations/20260716120000_p3b_dispute_disposition/migration.sql',
  'libs/talent-trust/prisma/migrations/20261014120000_g1_trust_recompute_requested_at/migration.sql',
];

// Resolve the ordered talent-trust migration .sql paths against a repo root.
export function resolveTalentTrustMigrations(repoRoot: string): string[] {
  return TALENT_TRUST_MIGRATIONS.map((p) => resolve(repoRoot, p));
}
