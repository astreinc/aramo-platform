import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §2.7 (+ ratification
// safeguard 1) — the erasure authorization is CONFINED, exact-path and default-
// deny, like the T0 reset marker (marker-confinement.spec.ts). Each token is
// CONSTRUCTED from fragments so this file never names it. Every tracked file that
// names a token MUST be one of its exact allowlisted paths: the migrations that
// define the subject-bound trigger branches and the entry point, the ONE service
// that calls the entry point, the S2 database-boundary proof, and the runbook
// (operator-role grant). Nothing else — no controller, DTO, repository, helper,
// env reader or unrelated test may name them.
const S2_MIGRATIONS = [
  'libs/consent/prisma/migrations/20261016180000_s2_erasure_run_authorization/migration.sql',
  'libs/activity/prisma/migrations/20261016180100_s2_activity_note_event_erasure_delete/migration.sql',
  'libs/documents/prisma/migrations/20261016180200_s2_document_event_erasure_delete/migration.sql',
  'libs/pipeline/prisma/migrations/20261016180300_s2_pipeline_history_erasure_redaction/migration.sql',
  'libs/client-selection/prisma/migrations/20261016180400_s2_client_selection_event_erasure_redaction/migration.sql',
  'libs/client-talent-restriction/prisma/migrations/20261016180500_s2_client_talent_restriction_erasure_redaction/migration.sql',
];
const S2_PROOF = 'apps/api/src/tests/s2-erasure-integrity.integration.spec.ts';
const SERVICE = 'apps/api/src/talent-identity/talent-erasure.service.ts';
const RUNBOOK = 'doc/runbooks/talent-rtbf-erasure.md';

const TOKENS: Array<{ name: string; token: string; allow: string[] }> = [
  // The transaction-local run setting: set ONLY inside the entry point; read ONLY by the triggers.
  { name: 'run setting', token: ['app', 'talent_erasure_run'].join('.'), allow: [...S2_MIGRATIONS, S2_PROOF] },
  // The SECURITY DEFINER entry point: defined once, called by the erasure service only.
  { name: 'entry point', token: ['s2', 'begin', 'talent', 'erasure', 'run'].join('_'), allow: [S2_MIGRATIONS[0]!, SERVICE, S2_PROOF] },
  // The definer role: nobody is ever granted membership.
  { name: 'definer role', token: ['aramo', 'erasure', 'definer'].join('_'), allow: [S2_MIGRATIONS[0]!, S2_PROOF] },
  // The operator role: granted to an operator login per the runbook.
  { name: 'operator role', token: ['aramo', 'erasure', 'operator'].join('_'), allow: [S2_MIGRATIONS[0]!, S2_PROOF, RUNBOOK] },
];

describe('S2 erasure-authorization confinement — exact-path default-deny (§2.7)', () => {
  const root = execSync('git rev-parse --show-toplevel').toString().trim();
  for (const { name, token, allow } of TOKENS) {
    it(`every tracked file naming the ${name} is in its exact allowlist`, () => {
      let occurrences: string[] = [];
      try {
        occurrences = execSync(`git grep -l -F -e ${JSON.stringify(token)}`, { cwd: root, maxBuffer: 32 * 1024 * 1024 })
          .toString()
          .split('\n')
          .filter((f) => f.length > 0);
      } catch {
        occurrences = [];
      }
      expect(occurrences.length, `the ${name} must be defined somewhere`).toBeGreaterThan(0);
      const offenders = occurrences.filter((f) => !allow.includes(f));
      expect(offenders, `the ${name} appears outside its exact allowlist:\n  ${offenders.join('\n  ')}`).toEqual([]);
    });
  }
});
