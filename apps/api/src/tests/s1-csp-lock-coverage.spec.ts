import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §4.4(g) / LR-F check 1 — LOCK
// COVERAGE (static guard). The client-submittal-policy linearization holds only if EVERY
// writer of policy_store."StoredPolicyVersion" that can change an effective client-submittal
// policy takes the per-tenant EXCLUSIVE advisory lock. This spec inventories every non-test
// writer of that table in apps/ + libs/ and pins the complete set:
//   - apps/api client-submittal-policy gateway adapter → MUST take acquireCspPublishLock first;
//   - apps/api engagement gateway adapter → writes only `engagement-policy*` packages;
//   - libs/policy-store PolicyStore.publish → MUST refuse the client-submittal-policy family.
// A NEW writer fails this spec until it is classified (a bypassing writer voids the guarantee).

const ROOT = resolve(__dirname, '../../../..');
const WRITE_PATTERNS = [
  /INSERT INTO\s+"?policy_store"?\."?StoredPolicyVersion"?/,
  /UPDATE\s+"?policy_store"?\."?StoredPolicyVersion"?/,
  /DELETE FROM\s+"?policy_store"?\."?StoredPolicyVersion"?/,
  /storedPolicyVersion\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/,
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'generated' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) && !p.includes(`${'/'}tests${'/'}`)) out.push(p);
  }
}

function writers(): string[] {
  const files: string[] = [];
  walk(join(ROOT, 'apps'), files);
  walk(join(ROOT, 'libs'), files);
  return files
    .filter((f) => WRITE_PATTERNS.some((re) => re.test(readFileSync(f, 'utf8'))))
    .map((f) => relative(ROOT, f))
    .sort();
}

const CSP_ADAPTER = 'apps/api/src/client-submittal-policy/client-submittal-policy-gateway.adapter.ts';
const ENGAGEMENT_ADAPTER = 'apps/api/src/engagement/engagement-policy-gateway.adapter.ts';
const POLICY_STORE = 'libs/policy-store/src/lib/policy-store.ts';

describe('client-submittal-policy lock coverage (v1.2 §4.4(g))', () => {
  it('the complete set of StoredPolicyVersion writers is exactly the three classified writers', () => {
    expect(writers()).toEqual([CSP_ADAPTER, ENGAGEMENT_ADAPTER, POLICY_STORE].sort());
  });

  it('the client-submittal-policy adapter takes the EXCLUSIVE lock before any read or write', () => {
    const src = readFileSync(join(ROOT, CSP_ADAPTER), 'utf8');
    const body = src.slice(src.indexOf('async insertVersion('));
    const lockAt = body.indexOf('acquireCspPublishLock(tx');
    const firstSql = body.search(/\$queryRawUnsafe|\$executeRawUnsafe/);
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstSql);
  });

  it('PolicyStore.publish refuses the client-submittal-policy package family', () => {
    const src = readFileSync(join(ROOT, POLICY_STORE), 'utf8');
    expect(src).toContain("CLIENT_SUBMITTAL_POLICY_PACKAGE_PREFIX = 'client-submittal-policy'");
    expect(src).toMatch(/packageName\.startsWith\(`\$\{CLIENT_SUBMITTAL_POLICY_PACKAGE_PREFIX\}:`\)/);
  });

  it('the engagement adapter only writes engagement-policy packages (never client-submittal-policy)', () => {
    const src = readFileSync(join(ROOT, ENGAGEMENT_ADAPTER), 'utf8');
    expect(src).not.toMatch(/client-submittal-policy/);
  });
});
