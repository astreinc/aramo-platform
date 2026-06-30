import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ===========================================================================
// THE CROSS-TENANT PRIVACY WALL (I14) — CI-ENFORCED. Step 4a.
// ===========================================================================
// The identity_index schema is the global, tenant-spanning resolution index.
// It MUST NEVER carry a tenant_id or any PII column — the same-human key is an
// opaque, tenant-side-computed fingerprint. This spec is the compiler/CI guard
// the directive requires (§4 step 2): it fails the build if the wall is ever
// breached, by schema OR migration.

const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');
const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260630000000_init_identity_index/migration.sql',
);

// Every column the identity_index schema is ALLOWED to have, plus the
// intra-schema relation navigation fields (not DB columns). Anything outside
// this set must be justified by amending the wall deliberately — the test
// failure forces that conversation.
const ALLOWED_FIELDS = new Set<string>([
  // PersonCluster
  'id',
  'created_at',
  'updated_at',
  'fingerprints', // relation nav (PersonCluster -> ClusterFingerprint[])
  // ClusterFingerprint
  'cluster_id',
  'fingerprint',
  'kind',
  'cluster', // relation nav (ClusterFingerprint -> PersonCluster)
]);

// Tokens that must NEVER appear as a column anywhere in this schema. tenant_id
// breaks the tenant-agnostic invariant; the rest are PII the index may not hold.
const FORBIDDEN_TOKENS = [
  'tenant_id',
  'email',
  'phone',
  'ssn',
  'dob',
  'birthdate',
  'birth_date',
  'first_name',
  'last_name',
  'full_name',
  'address',
  'verified_email',
  'raw_email',
];

function schemaText(): string {
  return readFileSync(SCHEMA_PATH, 'utf8');
}

/**
 * Extract field names declared inside `model … { … }` blocks, ignoring
 * comments, attributes (@@…), and block delimiters.
 */
function modelFieldNames(text: string): string[] {
  const names: string[] = [];
  let inModel = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('model ')) {
      inModel = true;
      continue;
    }
    if (!inModel) continue;
    if (line === '}') {
      inModel = false;
      continue;
    }
    if (
      line.length === 0 ||
      line.startsWith('//') ||
      line.startsWith('///') ||
      line.startsWith('@@')
    ) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

describe('identity_index privacy wall (I14)', () => {
  // NOTE: these assertions operate on PARSED model field names, not raw text —
  // the schema's header comment legitimately discusses tenant_id/PII to explain
  // the wall; only an actual column declaration is a breach.
  it('declares NO tenant_id column anywhere (tenant-agnostic index)', () => {
    const fields = new Set(modelFieldNames(schemaText()));
    expect(fields.has('tenant_id'), 'tenant_id column present').toBe(false);
  });

  it('declares NO known-PII column (only opaque fingerprints cross the wall)', () => {
    const fields = new Set(modelFieldNames(schemaText()));
    for (const token of FORBIDDEN_TOKENS) {
      expect(fields.has(token), `forbidden column '${token}' present`).toBe(false);
    }
  });

  it('declares ONLY allowlisted fields — a new column forces a wall review', () => {
    const offenders = modelFieldNames(schemaText()).filter(
      (name) => !ALLOWED_FIELDS.has(name),
    );
    expect(
      offenders,
      `unexpected field(s) ${JSON.stringify(offenders)} — if intentional, update ALLOWED_FIELDS AND re-confirm the I14 wall`,
    ).toEqual([]);
  });

  it('keeps the migration free of tenant_id / PII tokens too', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8').toLowerCase();
    for (const token of FORBIDDEN_TOKENS) {
      // word-ish boundary check against quoted column DDL like "tenant_id"
      expect(sql.includes(`"${token}"`), `migration declares '${token}'`).toBe(false);
    }
  });

  it('pins both tables to the identity_index schema only', () => {
    const text = schemaText();
    expect(text).toMatch(/schemas\s*=\s*\["identity_index"\]/);
    const schemaTags = [...text.matchAll(/@@schema\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(schemaTags.length).toBeGreaterThan(0);
    expect(schemaTags.every((s) => s === 'identity_index')).toBe(true);
  });
});
