// ATI-SEP-1 A2 — the talent_evidence COLUMN migrations later than the
// 20260915180000 skill-tax prefix that hand-picked integration sets carry, which
// a Prisma read/create of an already-present table now projects (e.g.
// TalentWorkHistoryEntry.assertions). Spread right after the talent_evidence
// prefix; the NEXT such column is a one-line edit HERE. Repo-root-relative.
//
// (ATI-SEP-1 T10 WP5 — moved here from the retired talent-trust migration
// helper, which was deleted with libs/talent-trust.)
export const TALENT_EVIDENCE_LATE_COLUMN_MIGRATIONS: readonly string[] = [
  'libs/talent-evidence/prisma/migrations/20261024110000_ati_sep_1_work_history_assertions/migration.sql',
];
