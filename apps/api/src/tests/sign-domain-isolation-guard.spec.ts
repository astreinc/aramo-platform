import { execSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

// Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-1/R-5, §3 H-2 — the
// Sign data boundary is CI-enforced, exact-path and default-deny (the S2 confinement-spec
// precedent). Aramo Sign owns the sign schema; every other product reaches Sign through its
// contracts (the authenticated Sign API, webhooks, the talent-erasure contract), never
// through its tables or its data library. Three walls:
//   1. SQL naming a Sign table (sign."X" / "sign"."X" / the pre-rename esign."X") appears only
//      in Sign's own code or an enumerated exception below;
//   2. the Sign data library (@aramo/sign) is imported only by Sign and the enumerated
//      exceptions;
//   3. nothing outside Sign calls the retired unauthenticated provider seam.
// A new reference fails here until it is justified and listed. The database-permission
// proof of the same boundary is sign-domain-roles.integration.spec.ts.

const SIGN_OWNED = [/^libs\/sign\//, /^apps\/sign-service\//];

// Each exception names why it is not a cross-product access.
const SQL_EXCEPTIONS: Record<string, string> = {
  // Historic migrations are immutable; both are superseded by
  // libs/documents/prisma/migrations/20261030040000_sign_isolation_document_event_guard.
  'libs/documents/prisma/migrations/20261016180200_s2_document_event_erasure_delete/migration.sql': 'historic, superseded',
  'libs/documents/prisma/migrations/20261020130500_sign_naming_erasure_guard/migration.sql': 'historic, superseded',
  // Sign-owned operator tooling: the schema-rename rollback.
  'tools/sign-naming/reverse.sql': 'Sign rename rollback tooling',
  // The sign-service Pact provider harness seeds Sign's own provider states.
  'pact/provider/src/verify-sign.ts': 'Sign provider verification harness',
  // Whole-database backup tooling (every schema, by design).
  'deploy/backup/aramo-backup.test.sh': 'whole-database backup fixture',
  // Identity-owned M-A8 dependency inspection, invoked ONLY by sign-service's Personal
  // account deletion (it runs under Sign's database credential), and its proof.
  'libs/identity/src/lib/privacy/identity-dependency-inspector.service.ts': 'invoked by sign-service only',
  'libs/identity/src/tests/m-a8-remove-sign-access.integration.spec.ts': 'proof of the sign-service-invoked path',
  // This boundary's own database-permission proof.
  'apps/api/src/tests/sign-domain-roles.integration.spec.ts': 'the permission proof itself',
};

const IMPORT_EXCEPTIONS: Array<{ path: RegExp; why: string }> = [
  // The platform operator console decides Sign abuse reports and reads the Sign privacy
  // inventory (Personal Free §6.4, M-A7 §3) — the operator plane, not a product. Recorded as
  // a hardening observation (narrow it to Sign APIs) in the reconciliation report.
  { path: /^apps\/platform-admin\//, why: 'platform operator console' },
  { path: /^pact\/provider\//, why: 'Sign provider verification harness' },
];

const SEAM_EXCEPTIONS = new Set([
  // The provider describes its own (retired, fail-closed) surface.
  'openapi/sign.yaml',
  'mobile/sign/src/api/generated/sign.ts',
  // Comment only: the retired seam is named to say it is gone.
  'pact/consumers/sign-consumer/src/esign.consumer.test.ts',
]);

const root = execSync('git rev-parse --show-toplevel').toString().trim();

function grep(args: string): string[] {
  try {
    return execSync(`git grep -l -I ${args}`, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      .toString()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

const signOwned = (f: string): boolean => SIGN_OWNED.some((re) => re.test(f));
// This guard names the patterns it looks for, so it excludes itself from every scan.
const SELF = ':!apps/api/src/tests/sign-domain-isolation-guard.spec.ts';
const CODE = `-- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.sql' '*.sh' ':!doc/generated/**' '${SELF}'`;

describe('Sign domain isolation — CI walls (Domain Isolation V1 §2 R-5)', () => {
  it('SQL naming a Sign table appears only in Sign code or an enumerated exception', () => {
    const files = grep(`-E -e '(^|[^A-Za-z0-9_])"?e?sign"?[[:space:]]*\\.[[:space:]]*"[A-Z]' ${CODE}`);
    expect(files.length, 'the scan must see Sign-owned SQL (a vacuous scan is a broken guard)').toBeGreaterThan(0);
    const offenders = files.filter((f) => !signOwned(f) && !(f in SQL_EXCEPTIONS));
    expect(offenders, `cross-product SQL against the sign schema:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('every SQL exception still exists (stale allowlist entries are removed, never kept)', () => {
    const files = new Set(grep(`-E -e '(^|[^A-Za-z0-9_])"?e?sign"?[[:space:]]*\\.[[:space:]]*"[A-Z]' ${CODE}`));
    expect(Object.keys(SQL_EXCEPTIONS).filter((f) => !files.has(f))).toEqual([]);
  });

  it('the ATS erasure engine and the documents domain carry no Sign SQL', () => {
    const files = grep(
      `-E -e '"?e?sign"?[[:space:]]*\\.[[:space:]]*"[A-Z]' -- 'apps/api/**' ':!apps/api/src/tests/sign-domain-roles.integration.spec.ts' '${SELF}' 'libs/documents/src/**'`,
    );
    expect(files).toEqual([]);
  });

  it('the Sign data library is imported only by Sign and the enumerated exceptions', () => {
    const files = grep(`-E -e "(from|import\\()[[:space:]]*['\\"]@aramo/sign['\\"]" ${CODE}`);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => !signOwned(f) && !IMPORT_EXCEPTIONS.some((e) => e.path.test(f)));
    expect(offenders, `@aramo/sign imported outside Sign:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('nothing outside Sign calls the retired unauthenticated provider seam', () => {
    const files = grep(`-F -e '/v1/sign/envelopes' -- ':!*.md' ':!doc/generated/**' '${SELF}'`);
    const offenders = files.filter((f) => !signOwned(f) && !SEAM_EXCEPTIONS.has(f));
    expect(offenders, `a caller of the retired /v1/sign/envelopes seam:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
