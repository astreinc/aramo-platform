import { resolve } from 'node:path';

// ATI-SEP-1 T10 WP5 — the shared skills_taxonomy migration set (the
// identity-migrations.ts precedent). MatchingService reads the ACTIVE platform
// skills_taxonomy."MatchingPolicyVersion" (ATI-SEP-1 P1) on every examination
// mint, so every AppModule integration spec that reaches matching needs the
// schema + the seeded v1 policy. This is the single ordered source of truth:
// the NEXT skills-taxonomy migration is a ONE-LINE edit HERE, not an N-spec
// sweep. APPLY order = timestamp order (the migrations are self-contained in
// the skills_taxonomy schema). Paths are repo-root-relative.
export const SKILLS_TAXONOMY_MIGRATIONS: readonly string[] = [
  'libs/skills-taxonomy/prisma/migrations/20260915140000_init_skill_registry/migration.sql',
  'libs/skills-taxonomy/prisma/migrations/20260915150000_skill_alias_version/migration.sql',
  'libs/skills-taxonomy/prisma/migrations/20260915160000_skill_relationship/migration.sql',
  'libs/skills-taxonomy/prisma/migrations/20260917210000_skill_tax_1f_governance/migration.sql',
  'libs/skills-taxonomy/prisma/migrations/20260917211000_skill_tax_1f_audit_append_only/migration.sql',
  'libs/skills-taxonomy/prisma/migrations/20260918120000_skill_tax_1f_b_governance_proposal_correction/migration.sql',
  'libs/skills-taxonomy/prisma/migrations/20261023140000_matching_policy/migration.sql',
];

// Resolve the ordered skills-taxonomy migration .sql paths against a repo root.
export function resolveSkillsTaxonomyMigrations(repoRoot: string): string[] {
  return SKILLS_TAXONOMY_MIGRATIONS.map((p) => resolve(repoRoot, p));
}
