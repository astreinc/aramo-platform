import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// IC-4 PR-9 §5 — the Talent Portal identity namespace stays SEPARATE from the
// tenant identity spine (IC-0 §H option 1; Identity-Rail D1–D3). Static,
// repository-level guards: the two Prisma schemas share no relation, the portal
// user carries no tenant or identity.User pointer, and neither library imports
// the other. These are the documented interface's invariants
// (doc/09-identity-portal-interoperability-boundary.md); an account-linking
// feature would have to change THIS spec under its own authorized contract.

const ROOT = resolve(__dirname, '../../../..');
const PORTAL_SCHEMA = readFileSync(resolve(ROOT, 'libs/portal-identity/prisma/schema.prisma'), 'utf8');
const IDENTITY_SCHEMA = readFileSync(resolve(ROOT, 'libs/identity/prisma/schema.prisma'), 'utf8');

function modelBlock(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  expect(start, `model ${model}`).toBeGreaterThanOrEqual(0);
  const end = schema.indexOf('\n}', start);
  return schema.slice(start, end);
}

function gitGrep(pattern: string, pathspec: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '--untracked', '-l', '-E', pattern, '--', pathspec], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter((l) => l.length > 0);
  } catch {
    // git grep exits 1 when nothing matches — a clean result.
    return [];
  }
}

describe('IC-4 PR-9 — Talent Portal identity namespace boundary (static)', () => {
  it('PortalUser is keyed by its own normalized email and carries NO tenant_id, NO identity.User pointer and NO relation', () => {
    const block = modelBlock(PORTAL_SCHEMA, 'PortalUser');
    expect(block).toMatch(/email_normalized\s+String\s+@unique/);
    expect(block).not.toMatch(/\btenant_id\b/);
    expect(block).not.toMatch(/\buser_id\b/);
    expect(block).not.toMatch(/@relation/);
    // The only cross-schema pointer is the PII-free cluster id — a UUID ref with no FK.
    expect(block).toMatch(/cluster_id\s+String\?\s+@db\.Uuid/);
  });
  it('the portal schema lives in its own Postgres schema and never references the identity schema (and vice versa)', () => {
    expect(PORTAL_SCHEMA).toMatch(/@@schema\("portal_identity"\)/);
    expect(PORTAL_SCHEMA).not.toMatch(/@@schema\("identity"\)/);
    expect(PORTAL_SCHEMA).not.toMatch(/\bmodel (User|Tenant|UserTenantMembership)\b/);
    expect(IDENTITY_SCHEMA).not.toMatch(/portal_identity|PortalUser/);
  });
  it('libs/identity never imports @aramo/portal-identity and libs/portal-identity never imports @aramo/identity (no code-level aggregation seam)', () => {
    // Patterns are regexes that match an IMPORT of the other library, written so
    // that this spec's own source never matches them.
    expect(gitGrep("from ['\"]@aramo/portal-identity['\"]", 'libs/identity/src')).toEqual([]);
    expect(gitGrep("from ['\"]@aramo/identity['\"]", 'libs/portal-identity/src')).toEqual([]);
  });
  it('consent and portal-dispute data stay tenant-scoped records keyed by tenant_id — no column binds them to an identity.User', () => {
    const consent = readFileSync(resolve(ROOT, 'libs/consent/prisma/schema.prisma'), 'utf8');
    for (const model of ['TalentConsentEvent', 'ConsentAuditEvent']) {
      const block = modelBlock(consent, model);
      expect(block).toMatch(/tenant_id\s+String\s+@db\.Uuid/);
      expect(block).not.toMatch(/portal_user_id|identity_user_id|@relation/);
    }
  });
});
