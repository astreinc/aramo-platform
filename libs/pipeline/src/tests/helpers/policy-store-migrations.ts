// Talent Lifecycle R1–R5 Implementation Directive v1.2 §4.6 — a `qualified` transition now
// writes its applied RTR policy (source / version / checksum / t_L) to
// policy_store."PolicyDecisionRecord" IN the transition transaction. The ONE shared
// migration set every hand-wired Pipeline substrate spec that reaches `qualified` appends
// (paths relative to libs/pipeline/src/tests, the convention of those specs' MIGRATIONS).
export const POLICY_STORE_DECISION_RECORD_MIGRATIONS: readonly string[] = [
  '../../../../libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql',
  '../../../../libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql',
];
