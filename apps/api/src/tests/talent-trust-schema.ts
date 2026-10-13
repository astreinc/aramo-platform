import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// INC-1b (TIP-E2E) test fixture — apply the talent_trust schema for integration specs
// that create submittals. The global TalentAnchorInterceptor (ADR-0033 talent-anchor,
// merged from main) fires on talent-record / submittal mutations and writes
// talent_trust.ResolutionSubjectRef; without the schema, POST /v1/submittals 500s in
// setup. The examine integration specs already migrate talent_trust inline — this helper
// is the shared, drift-proof equivalent for the submittal negative-shape specs. It applies
// every talent-trust migration in timestamp (directory-name) order.
export async function applyTalentTrustSchema(
  query: (sql: string) => Promise<unknown>,
  root: string,
): Promise<void> {
  const dir = resolve(root, 'libs/talent-trust/prisma/migrations');
  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of migrations) {
    await query(readFileSync(resolve(dir, name, 'migration.sql'), 'utf8'));
  }
}
