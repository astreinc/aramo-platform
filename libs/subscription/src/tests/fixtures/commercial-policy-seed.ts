import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CCP-A2 test helper — reads the v1 policy document and checksum straight out of the
// seeding migration, so the unit tests exercise the DATA the database receives (never a
// restated constant).

export const CCP_A2_MIGRATION = resolve(
  __dirname,
  '../../../prisma/migrations/20261024180000_ccp_a2_commercial_audit_policy/migration.sql',
);

export function seededPolicyV1(): { content: unknown; checksum: string } {
  const sql = readFileSync(CCP_A2_MIGRATION, 'utf8');
  const seed = sql.slice(sql.indexOf('-- commercial-policy-v1-content'));
  const m = /'(\{"approval_expiry_hours".*?\})'::jsonb,\s*'([0-9a-f]{64})'/s.exec(seed);
  if (m === null || m[1] === undefined || m[2] === undefined) throw new Error('v1 policy literal not found in the A2 migration');
  return { content: JSON.parse(m[1]) as unknown, checksum: m[2] };
}
