// HYG-3 — orphan-scope guard.
//
// Every scope in the seeded catalog (SEED_SCOPE_KEYS + PLATFORM_SCOPE_KEYS in
// libs/identity/src/lib/dto/scope.dto.ts) must fall into exactly one MACHINE-
// classified state:
//   ENFORCED             — appears in a literal @RequireScopes('scope') guard.
//   DYNAMICALLY_ENFORCED — enforced via a computed `${...}` scope expression
//                          (e.g. placement:${cls}); listed in CLASSIFICATIONS.
//   SERVICE_ENFORCED     — enforced below the route (interceptor / repository
//                          write-gate / field-mask); listed in CLASSIFICATIONS.
//   ACTIVE_RESERVED      — deliberate forward-reservation tied to a named authority.
//   COMPATIBILITY_RESERVED — kept for compatibility.
//   EXIT_HYG             — a live-surface authz question handed to an owning lane.
//   CATALOG_ONLY_ZERO_GRANT — seeded catalog-only, granted to no role by design.
//
// A scope that is granted/registered but neither literally enforced nor present
// in CLASSIFICATIONS (with a reason) is an UNEXPLAINED ORPHAN → CI fails. Per the
// Architect's HYG-3 principle: "no @RequireScopes" alone is NOT "dead"; the guard
// recognizes the classes above as first-class, reasoned allowlist states — never
// a heuristic comment guess.
//
// Run:       node --import jiti/register ci/scripts/verify-orphan-scopes.ts
// Self-test: SELF_TEST=1 node --import jiti/register ci/scripts/verify-orphan-scopes.ts

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const SCOPE_DTO = join(REPO_ROOT, 'libs', 'identity', 'src', 'lib', 'dto', 'scope.dto.ts');

export type ScopeClass =
  | 'DYNAMICALLY_ENFORCED'
  | 'SERVICE_ENFORCED'
  | 'ACTIVE_RESERVED'
  | 'COMPATIBILITY_RESERVED'
  | 'EXIT_HYG'
  | 'CATALOG_ONLY_ZERO_GRANT';

export interface Classification {
  cls: ScopeClass;
  reason: string;
}

// The single machine-governed registry of every catalog scope that is NOT a
// literal @RequireScopes enforcement. Each entry carries a class + a reason.
// (Populated iteratively against the live repo — see the HYG-3 build notes.)
export const CLASSIFICATIONS: Record<string, Classification> = {
  // --- ACTIVE_RESERVED (HYG-1 8-scope authority recon) ---
  'auth:session:read': { cls: 'ACTIVE_RESERVED', reason: 'baseline session marker; gate role superseded by consumer_type gating, retained pending F31 scope-registry design (M3-PR-9 Ruling 7)' },
  'identity:user:read': { cls: 'ACTIVE_RESERVED', reason: 'Lead-ratified auditor/compliance bundle (E2 §182); read surface deferred to Reporting/Audit DDR' },
  'identity:tenant:read': { cls: 'ACTIVE_RESERVED', reason: 'same auditor/compliance bundle' },
  'assignment:create': { cls: 'ACTIVE_RESERVED', reason: 'Track4/T4-D ratified ContractAssignment authority; no live handler yet' },
  'assignment:update': { cls: 'ACTIVE_RESERVED', reason: 'same T4-D authority; dormant, cited as the reserved verb in live placement code' },
  'examination:read': { cls: 'ACTIVE_RESERVED', reason: 'examination-read gate reserved by the OpenAPI contract (x-required-scope on 5 routes; PR-A1a-2 §48); no live handler yet' },
  // --- EXIT_HYG (owning-lane ruling required) ---
  'consent:read': { cls: 'EXIT_HYG', reason: 'live internal ConsentController surface; keep-or-gate is a Consent/Portal-lane ruling (Dead-Residue Ledger)' },
  'consent:write': { cls: 'EXIT_HYG', reason: 'same' },
  // --- DYNAMICALLY_ENFORCED (computed `placement:${cls}` at placement.controller.ts:170) ---
  'placement:transition': { cls: 'DYNAMICALLY_ENFORCED', reason: 'computed `placement:${cls}` guard (placement.controller.ts:170)' },
  'placement:activate': { cls: 'DYNAMICALLY_ENFORCED', reason: 'computed `placement:${cls}` guard (placement.controller.ts:170)' },
  'placement:terminate': { cls: 'DYNAMICALLY_ENFORCED', reason: 'computed `placement:${cls}` guard (placement.controller.ts:170)' },
  // --- SERVICE_ENFORCED (scopes.includes / field-mask / edit-gate / visibility-resolver) ---
  'placement:replace': { cls: 'SERVICE_ENFORCED', reason: 'auth.scopes.includes(placement:replace) (placement.controller.ts:118)' },
  'requisition:approve': { cls: 'SERVICE_ENFORCED', reason: 'approval-authorization-gate.ts:37 scopes.includes(REQUISITION_APPROVE)' },
  'talent:search': { cls: 'SERVICE_ENFORCED', reason: 'talent-record.controller.ts:153 scopes.includes(talent:search)' },
  'company:search': { cls: 'SERVICE_ENFORCED', reason: 'company.controller.ts:96 scopes.includes(company:search)' },
  'requisition:search': { cls: 'SERVICE_ENFORCED', reason: 'requisition.controller.ts:120 scopes.includes(requisition:search)' },
  'contact:search': { cls: 'SERVICE_ENFORCED', reason: 'contact.controller.ts:65 scopes.includes(contact:search)' },
  'requisition:read:all': { cls: 'SERVICE_ENFORCED', reason: 'visibility filter — no assignment filter when held (requisition.repository.ts:128)' },
  'company:read:all': { cls: 'SERVICE_ENFORCED', reason: 'visibility-resolver see-all short-circuit (libs/visibility; SCOPE_COMPANY_READ_ALL)' },
  'activity:redact': { cls: 'SERVICE_ENFORCED', reason: 'activity.controller.ts:147 scopes.includes(activity:redact)' },
  'company:read_commercial': { cls: 'SERVICE_ENFORCED', reason: 'stripUnscopedCommercialFields(company.repository.ts:342/654)' },
  'compensation:view:pay': { cls: 'SERVICE_ENFORCED', reason: 'compensation-field-mask.interceptor.ts walkAndMask by scopes' },
  'compensation:view:bill': { cls: 'SERVICE_ENFORCED', reason: 'compensation-field-mask interceptor' },
  'compensation:view:revenue': { cls: 'SERVICE_ENFORCED', reason: 'compensation-field-mask interceptor' },
  'compensation:view:spread:amount': { cls: 'SERVICE_ENFORCED', reason: 'compensation-field-mask interceptor' },
  'compensation:view:spread:percent': { cls: 'SERVICE_ENFORCED', reason: 'compensation-field-mask interceptor' },
  'compensation:view:margin:percent': { cls: 'SERVICE_ENFORCED', reason: 'compensation-field-mask interceptor' },
  'compensation:edit:pay': { cls: 'SERVICE_ENFORCED', reason: 'compensation-edit-gate.ts assertScopedFieldGroupsPresent' },
  'compensation:edit:bill': { cls: 'SERVICE_ENFORCED', reason: 'compensation-edit-gate.ts assertScopedFieldGroupsPresent' },
  'requisition:view:financials': { cls: 'SERVICE_ENFORCED', reason: 'compensation/field-group edit-gate + financials field mask' },
  'requisition:edit:financials': { cls: 'SERVICE_ENFORCED', reason: 'compensation-edit-gate.ts field-group write gate' },
  'requisition:edit:status': { cls: 'SERVICE_ENFORCED', reason: 'status-edit-gate.ts — narrow status-only write tier (requisition.controller.ts:252)' },
  'requisition:profile:edit': { cls: 'SERVICE_ENFORCED', reason: 'field-group-edit-gate PROFILE tier (requisition.controller.ts:379)' },
  'communication:notes:write': { cls: 'SERVICE_ENFORCED', reason: 'communication-timeline.service.ts:57 scopes.includes(communication:notes:write)' },
  'pre_start_requirement:waive_advisory': { cls: 'SERVICE_ENFORCED', reason: 'pre-start-waiver.service.ts:52 scopes.includes(required)' },
  'pre_start_requirement:waive_blocking': { cls: 'SERVICE_ENFORCED', reason: 'pre-start-waiver.service.ts:52 scopes.includes(required); §13c-1 registered zero-grant' },
  'pre_start_requirement:read_restricted_evidence': { cls: 'SERVICE_ENFORCED', reason: 'pre-start-requirement.controller.ts:131 scopes.includes(READ_RESTRICTED_EVIDENCE_SCOPE)' },
  // --- CATALOG_ONLY_ZERO_GRANT (seeded, granted to no role by design) ---
  'requisition:create:establish': { cls: 'CATALOG_ONLY_ZERO_GRANT', reason: 'L1-A functional create qualifier; NO RoleScope grant — held programmatically by system/bootstrap identities only (seed.ts:2496)' },
  // --- ACTIVE_RESERVED (portal JWT contract; surfaced by this guard beyond the original 8) ---
  'portal:profile:edit': { cls: 'ACTIVE_RESERVED', reason: 'member of PORTAL_SESSION_SCOPES (portal JWT contract, session-orchestrator.service.ts:42); write-sibling of the enforced portal:profile:read, reserved for the portal profile-edit surface not yet built' },
};

function extractArray(source: string, name: string): string[] {
  const m = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`));
  if (m === null || m[1] === undefined) return [];
  return [...m[1].matchAll(/'([a-zA-Z0-9:_-]+)'/g)].map((mm) => mm[1]!);
}

export function readCatalog(): string[] {
  const src = readFileSync(SCOPE_DTO, 'utf8');
  return [...extractArray(src, 'SEED_SCOPE_KEYS'), ...extractArray(src, 'PLATFORM_SCOPE_KEYS')];
}

// The set of scopes appearing in a literal @RequireScopes('X') anywhere in code.
export function readLiteralEnforced(): Set<string> {
  const out = execSync(
    `git -C ${REPO_ROOT} grep -h -oE "@RequireScopes\\([^)]*\\)" -- 'apps/**/*.ts' 'libs/**/*.ts'`,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const set = new Set<string>();
  for (const m of out.matchAll(/'([a-zA-Z0-9:_-]+)'/g)) set.add(m[1]!);
  return set;
}

export interface Issue {
  scope: string;
  reason: string;
}

// Pure classifier: a catalog scope must be literally enforced OR classified.
export function verify(
  catalog: string[],
  enforced: ReadonlySet<string>,
  classifications: Record<string, Classification>,
): Issue[] {
  const issues: Issue[] = [];
  for (const s of catalog) {
    if (enforced.has(s)) continue;
    const c = classifications[s];
    if (c === undefined) {
      issues.push({
        scope: s,
        reason: `UNEXPLAINED ORPHAN: not literally enforced and not in CLASSIFICATIONS. Add a @RequireScopes guard, or classify it (DYNAMICALLY_ENFORCED / SERVICE_ENFORCED / ACTIVE_RESERVED / COMPATIBILITY_RESERVED / EXIT_HYG / CATALOG_ONLY_ZERO_GRANT) with a reason.`,
      });
      continue;
    }
    if (!c.reason || c.reason.trim().length === 0) {
      issues.push({ scope: s, reason: `classified ${c.cls} but no reason given` });
    }
  }
  return issues;
}

function checkRepo(): Issue[] {
  return verify(readCatalog(), readLiteralEnforced(), CLASSIFICATIONS);
}

function runSelfTest(): void {
  const enforced = new Set(['a:enforced']);
  const classifications: Record<string, Classification> = {
    'b:reserved': { cls: 'ACTIVE_RESERVED', reason: 'reserved for X' },
  };

  // Clean: enforced + classified both pass.
  const ok = verify(['a:enforced', 'b:reserved'], enforced, classifications);
  if (ok.length !== 0) throw new Error(`self-test: clean catalog flagged: ${JSON.stringify(ok)}`);

  // NEGATIVE: a granted/registered scope that is neither enforced nor classified MUST fail.
  const orphan = verify(['fake:orphan'], enforced, classifications);
  if (!orphan.some((i) => i.scope === 'fake:orphan' && i.reason.startsWith('UNEXPLAINED'))) {
    throw new Error('self-test: orphan scope NOT flagged — guard does not protect the invariant');
  }

  // POSITIVE: the same scope, once explicitly classified with a reason, passes.
  const nowClassified = verify(['fake:orphan'], enforced, {
    'fake:orphan': { cls: 'ACTIVE_RESERVED', reason: 'reserved pending X' },
  });
  if (nowClassified.length !== 0) throw new Error('self-test: classified scope wrongly flagged');

  // A classification with an empty reason is rejected.
  const noReason = verify(['fake:orphan'], enforced, {
    'fake:orphan': { cls: 'ACTIVE_RESERVED', reason: '' },
  });
  if (!noReason.some((i) => i.reason.includes('no reason'))) {
    throw new Error('self-test: empty-reason classification not flagged');
  }

  console.log('self-test ok: orphan-scope guard flags unexplained orphans, passes enforced/classified');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log('orphan-scopes:check ok');
    return;
  }
  console.error(`orphan-scopes:check FAILED — ${issues.length} unexplained/underspecified scope(s):`);
  for (const i of issues) console.error(`  ${i.scope}: ${i.reason}`);
  process.exit(1);
}

main();
