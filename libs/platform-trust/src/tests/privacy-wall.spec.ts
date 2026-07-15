import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// ===========================================================================
// THE PLATFORM-TRUST PRIVACY WALL (D3) — CI-ENFORCED. TR-2b B2a.
// ===========================================================================
// The platform_trust schema records that a cluster is dormant, awaiting the P4
// notice lifecycle. It MUST NEVER carry a tenant_id or any PII column, and NEVER
// a tenant-identifying value — recording WHICH tenants a cluster spans would
// re-introduce the origin join D3 forbids. A DormantLink names only a
// PERSON_CLUSTER id + a lifecycle status. This spec (cloned from the
// identity-index I14 wall) fails the build if the wall is ever breached, by
// schema OR migration, and RUNS IN THE SAME CI JOB as the identity-index wall
// (the `identity-index:privacy-wall` npm script chains it).

const SCHEMA_PATH = resolve(__dirname, '../../prisma/schema.prisma');
const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260715120000_init_platform_trust/migration.sql',
);

// Every column the platform_trust schema is ALLOWED to have. Anything outside
// this set must be justified by amending the wall deliberately — the test
// failure forces that conversation (Directive standing invariant: no allowlist
// edit without HALT).
const ALLOWED_FIELDS = new Set<string>([
  // DormantLink
  'id',
  'cluster_id',
  'detected_at',
  'status',
  'notice_version',
  'notice_delivered_at',
  'expires_at',
  'created_at',
  'updated_at',
]);

// Tokens that must NEVER appear as a column anywhere in this schema. tenant_id
// breaks the tenant-agnostic invariant; the rest are PII the substrate may not
// hold.
const FORBIDDEN_TOKENS = [
  'tenant_id',
  'tenant_name',
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

describe('platform_trust privacy wall (D3)', () => {
  // NOTE: these assertions operate on PARSED model field names, not raw text —
  // the schema's header comment legitimately discusses tenant_id/PII to explain
  // the wall; only an actual column declaration is a breach.
  it('declares NO tenant_id column anywhere (tenant-agnostic substrate)', () => {
    const fields = new Set(modelFieldNames(schemaText()));
    expect(fields.has('tenant_id'), 'tenant_id column present').toBe(false);
  });

  it('declares NO known-PII / tenant-identifying column', () => {
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
      `unexpected field(s) ${JSON.stringify(offenders)} — if intentional, update ALLOWED_FIELDS AND re-confirm the D3 wall`,
    ).toEqual([]);
  });

  it('keeps the migration free of tenant_id / PII tokens too', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8').toLowerCase();
    for (const token of FORBIDDEN_TOKENS) {
      // word-ish boundary check against quoted column DDL like "tenant_id"
      expect(sql.includes(`"${token}"`), `migration declares '${token}'`).toBe(false);
    }
  });

  it('pins the table to the platform_trust schema only', () => {
    const text = schemaText();
    expect(text).toMatch(/schemas\s*=\s*\["platform_trust"\]/);
    const schemaTags = [...text.matchAll(/@@schema\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(schemaTags.length).toBeGreaterThan(0);
    expect(schemaTags.every((s) => s === 'platform_trust')).toBe(true);
  });

  // The wall must PROVE it fires — a negative fixture the parser+forbidden-check
  // must catch (per the directive: "prove with the spec's own negative fixtures").
  it('FIRES on a synthetic tenant_id / PII column (the wall is not vacuous)', () => {
    const breach = [
      'model Bad {',
      '  id String @id',
      '  tenant_id String',
      '  email String',
      '  @@schema("platform_trust")',
      '}',
    ].join('\n');
    const fields = new Set(modelFieldNames(breach));
    // The forbidden-token assertion above would fail on this fixture:
    expect(fields.has('tenant_id')).toBe(true);
    expect(FORBIDDEN_TOKENS.some((t) => fields.has(t))).toBe(true);
    // And the allowlist diff would report it:
    const offenders = [...fields].filter((n) => !ALLOWED_FIELDS.has(n));
    expect(offenders).toContain('tenant_id');
    expect(offenders).toContain('email');
  });
});
