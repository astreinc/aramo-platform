import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// IC-1 PR-1 — D-AUTHZ-PLATFORM-INVITE-1 Amendment A1 §2/§5: the STATIC guard.
//
// (a) The retired AUTHZ-2 entry points — IdentityService.addMembershipFor
//     ExistingUser and IdentityRepository.createMembershipForExistingUser —
//     have NO definition and NO caller anywhere in the repo (test or
//     non-test). The regex requires the identifier to be followed by `(`
//     (a call or a definition), so prose comments naming the retired methods
//     do not count.
// (b) The ONLY runtime sites that create an identity.User are the two
//     User-creating transactions in IdentityRepository (each creates the User
//     AND its single membership atomically). Test fixtures, Prisma seeds and
//     the developer tooling under tools/ are excluded by path and listed
//     explicitly below so an addition anywhere else fails this guard.
//
// This runs `git grep` from the repo root (the CI checkout is a git work
// tree); `--untracked` keeps the guard honest on a developer's dirty tree.

const ROOT = resolve(__dirname, '../../../..');
const THIS_FILE = 'libs/identity/src/tests/ic1-user-create-sites.spec.ts';

function gitGrep(pattern: string): string[] {
  try {
    const out = execFileSync(
      'git',
      [
        'grep',
        '-nE',
        '--untracked',
        pattern,
        '--',
        ':(glob)**/*.ts',
        ':(glob)**/*.tsx',
        ':(exclude)**/node_modules/**',
        ':(exclude)**/dist/**',
        ':(exclude)**/generated/**',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return out.split('\n').filter((l) => l.length > 0);
  } catch (e) {
    // git grep exits 1 when nothing matches — that is a clean result.
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

function fileOf(hit: string): string {
  return hit.slice(0, hit.indexOf(':'));
}

// The WORKING-TREE source of the repository (what the build compiles), read from disk.
function readRepositorySource(): string {
  return readFileSync(resolve(ROOT, 'libs/identity/src/lib/identity.repository.ts'), 'utf8');
}

// Runtime User-create sites (production code). The two creation transactions.
const RUNTIME_USER_CREATE_SITES: ReadonlyArray<{ file: string; count: number }> = [
  { file: 'libs/identity/src/lib/identity.repository.ts', count: 2 },
];

// Non-runtime sites excluded by path: test fixtures, Prisma seeds, dev tooling.
const NON_RUNTIME_PATH = /(^|\/)(tests?|__tests__)\/|\.spec\.ts$|\.test\.ts$|\/prisma\/seed[^/]*\.ts$|^tools\/|^pact\//;

describe('IC-1 PR-1 — static guard: retired entry points + User-create sites', () => {
  it('addMembershipForExistingUser / createMembershipForExistingUser have ZERO definitions or callers (test or non-test)', () => {
    const hits = gitGrep(
      '(addMembershipForExistingUser|createMembershipForExistingUser)[[:space:]]*\\(',
    ).filter((h) => fileOf(h) !== THIS_FILE);
    expect(hits).toEqual([]);
  });

  it('the former `membership_added` outcome is referenced nowhere outside this guard', () => {
    const hits = gitGrep("'membership_added'").filter((h) => fileOf(h) !== THIS_FILE);
    expect(hits).toEqual([]);
  });

  it('the ONLY runtime identity.User create sites are the two creation transactions in IdentityRepository', () => {
    const hits = gitGrep('\\.user\\.(create|createMany|upsert)\\(');
    const runtime = hits.filter((h) => !NON_RUNTIME_PATH.test(fileOf(h)));
    const byFile = new Map<string, number>();
    for (const h of runtime) byFile.set(fileOf(h), (byFile.get(fileOf(h)) ?? 0) + 1);
    const observed = [...byFile.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => a.file.localeCompare(b.file));
    expect(observed).toEqual([...RUNTIME_USER_CREATE_SITES]);
  });

  // IC-1 PR-2 — both runtime creation transactions set the owning tenant from
  // the membership tenant in the SAME transaction (`tenant_id: args.tenant_id`
  // inside each `tx.user.create`). Exactly 2 such sites, in the repository.
  it('IC-1 PR-2: both runtime User creation transactions pass tenant_id (born owned)', () => {
    const source = readRepositorySource();
    const userCreates = source.split('tx.user.create({').slice(1);
    expect(userCreates).toHaveLength(2);
    for (const block of userCreates) {
      const dataBlock = block.slice(0, block.indexOf('});'));
      expect(dataBlock).toContain('tenant_id: args.tenant_id');
    }
  });

  it('no runtime site creates a bare UserTenantMembership for an existing User outside IdentityRepository', () => {
    const hits = gitGrep('\\.userTenantMembership\\.(create|createMany|upsert)\\(');
    const runtime = hits
      .map(fileOf)
      .filter((f) => !NON_RUNTIME_PATH.test(f));
    expect([...new Set(runtime)]).toEqual(['libs/identity/src/lib/identity.repository.ts']);
  });
});
