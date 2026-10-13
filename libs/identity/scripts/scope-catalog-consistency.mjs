#!/usr/bin/env node
// INC-1a (TIP-E2E) — PostgreSQL-free static scope-catalog consistency check.
//
// Deterministic, dependency-free (no Prisma, no Testcontainers): parses the
// authoritative source files textually and verifies the scope-catalog
// invariants a scope-add (e.g. examination:create) must preserve:
//   1. SEED_IDS.scopes (id-map, seed.ts) <-> SEED_SCOPE_KEYS (catalog,
//      scope.dto.ts) are a STRICT bijection (the same check the PG-backed
//      scope-catalog-parity.spec asserts, but runnable locally).
//   2. All scope ids are unique.
//   3. The scope count matches the pinned CATALOG_SCOPE_COUNT in
//      seed-scrub.integration.spec.ts (so a scope-add that forgets to bump the
//      locked constant fails here, locally, instead of only in CI).
//
// Exit 0 = consistent; exit 1 = a drift the seed-scrub integration suite would
// also catch. Run: node libs/identity/scripts/scope-catalog-consistency.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..'); // worktree root
const SEED = resolve(root, 'libs/identity/prisma/seed.ts');
const DTO = resolve(root, 'libs/identity/src/lib/dto/scope.dto.ts');
const SCRUB = resolve(root, 'libs/identity/src/tests/seed-scrub.integration.spec.ts');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

// --- 1. id-map: SEED_IDS.scopes block in seed.ts ---
const seedSrc = readFileSync(SEED, 'utf8').split('\n');
const idMap = new Map(); // key -> uuid
let inScopes = false;
for (const line of seedSrc) {
  if (!inScopes) {
    if (/^\s{2}scopes:\s*\{/.test(line)) inScopes = true;
    continue;
  }
  if (/^\s{2}\},/.test(line)) break; // end of scopes: { ... }
  const m = line.match(/^\s*'([^']+)':\s*'([0-9a-fA-F-]+)'/);
  if (m) {
    if (idMap.has(m[1])) fail(`duplicate scope key in id-map: ${m[1]}`);
    idMap.set(m[1], m[2]);
  }
}

// --- 2. catalog: SEED_SCOPE_KEYS array in scope.dto.ts ---
const dtoSrc = readFileSync(DTO, 'utf8').split('\n');
const catalog = new Set();
let inKeys = false;
for (const line of dtoSrc) {
  if (!inKeys) {
    if (/^export const SEED_SCOPE_KEYS\s*=\s*\[/.test(line)) inKeys = true;
    continue;
  }
  // Stop ONLY at the real array terminator (`] as const;`), not at any `]`
  // that may appear inside an interior comment.
  if (/^\s*\]\s*as const\s*;?/.test(line)) break;
  if (/^\s*\/\//.test(line)) continue; // skip comment lines
  const m = line.match(/^\s*'([^']+)'\s*,?/);
  if (m) catalog.add(m[1]);
}

// --- 3. pinned CATALOG_SCOPE_COUNT ---
const scrubSrc = readFileSync(SCRUB, 'utf8');
const pin = scrubSrc.match(/CATALOG_SCOPE_COUNT\s*=\s*(\d+)/);
const pinnedScopeCount = pin ? Number(pin[1]) : null;

// --- checks ---
const idKeys = new Set(idMap.keys());
const missingInCatalog = [...idKeys].filter((k) => !catalog.has(k));
const danglingInCatalog = [...catalog].filter((k) => !idKeys.has(k));
const ids = [...idMap.values()];
const dupIds = ids.filter((v, i) => ids.indexOf(v) !== i);

if (missingInCatalog.length) fail(`id-map keys absent from SEED_SCOPE_KEYS: ${missingInCatalog.join(', ')}`);
if (danglingInCatalog.length) fail(`SEED_SCOPE_KEYS keys absent from id-map: ${danglingInCatalog.join(', ')}`);
if (dupIds.length) fail(`duplicate scope ids: ${[...new Set(dupIds)].join(', ')}`);
if (pinnedScopeCount !== null && idMap.size !== pinnedScopeCount) {
  fail(`scope count ${idMap.size} != pinned CATALOG_SCOPE_COUNT ${pinnedScopeCount}`);
}

// --- 4. grant inventory: role -> scopes, across bundle tuples + ROLE_SCOPE_ASSIGNMENTS ---
// Bundle tuple form: ['role', [ 'scope', ... ]] (possibly multi-line).
// ROLE_SCOPE_ASSIGNMENTS form: { role: [ 'scope', ... ], ... }.
// super_admin is seeded ALL scopes programmatically (seed.ts header: "1 RoleScope
// -per-scope assignment for the super_admin bundle") — modelled as the full
// id-map so the tally is complete.
const grants = new Map(); // role -> Set(scope)
const add = (role, scope) => {
  if (!grants.has(role)) grants.set(role, new Set());
  grants.get(role).add(scope);
};
const wholeSeed = seedSrc.join('\n');
// bundle tuples
const tupleRe = /\[\s*'([a-z_]+)'\s*,\s*\[([\s\S]*?)\]\s*\]/g;
let t;
while ((t = tupleRe.exec(wholeSeed)) !== null) {
  const role = t[1];
  for (const sm of t[2].matchAll(/'([a-z0-9:_-]+)'/g)) add(role, sm[1]);
}
// ROLE_SCOPE_ASSIGNMENTS object block
let inRSA = false;
let rsaRole = null;
for (const line of seedSrc) {
  if (!inRSA) {
    if (/ROLE_SCOPE_ASSIGNMENTS\s*=\s*\{/.test(line)) inRSA = true;
    continue;
  }
  if (/^\};/.test(line) || /^\s*\}\s*as const/.test(line)) break;
  const open = line.match(/^\s{2,4}([a-z_]+):\s*\[/);
  if (open) { rsaRole = open[1]; }
  if (rsaRole) for (const sm of line.matchAll(/'([a-z0-9:_-]+)'/g)) add(rsaRole, sm[1]);
  if (/^\s{2,4}\],/.test(line)) rsaRole = null;
}
// super_admin is a PLATFORM-tier role bound ONLY to the platform:* scope namespace
// (seed.ts: enumerated platform bundle) — NOT an all-catalog-scopes role. It therefore
// does NOT hold tenant-tier ATS scopes such as examination:read / submittal:create /
// examination:create. (An earlier version modeled it as all-scopes, which over-counted
// the grant tally and wrongly implied super_admin in the examination:create set; the PG
// seed-scrub is the authority and reports 740 role-scope grants — consistent with
// super_admin NOT receiving examination:create.) We deliberately do NOT synthesize
// super_admin grants here.

let grantTotal = 0;
for (const s of grants.values()) grantTotal += s.size;
const pinG = scrubSrc.match(/CATALOG_ROLE_SCOPE_COUNT\s*=\s*(\d+)/);
const pinnedGrantCount = pinG ? Number(pinG[1]) : null;
const holds = (scope) => [...grants.entries()].filter(([, s]) => s.has(scope)).map(([r]) => r).sort();
const examReaders = holds('examination:read');
const submCreators = holds('submittal:create');
const authorized = examReaders.filter((r) => submCreators.includes(r));

console.log(`id-map scopes:        ${idMap.size}`);
console.log(`SEED_SCOPE_KEYS:      ${catalog.size}`);
console.log(`pinned CATALOG_SCOPE_COUNT: ${pinnedScopeCount ?? 'NOT FOUND'}`);
console.log(`bijection: ${missingInCatalog.length === 0 && danglingInCatalog.length === 0 ? 'OK' : 'BROKEN'}`);
console.log(`id uniqueness: ${dupIds.length === 0 ? 'OK' : 'BROKEN'}`);
console.log(`--- grant inventory (best-effort static tally) ---`);
console.log(`roles parsed:         ${grants.size}`);
console.log(`grant pairs (tally):  ${grantTotal}  | pinned CATALOG_ROLE_SCOPE_COUNT: ${pinnedGrantCount ?? 'NOT FOUND'}`);
console.log(`examination:read holders (${examReaders.length}): ${examReaders.join(', ')}`);
console.log(`submittal:create holders (${submCreators.length}): ${submCreators.join(', ')}`);
console.log(`examination:create authorized set = read ∩ create (${authorized.length}): ${authorized.join(', ')}`);

// --- 5. INC-1a: examination:create authorized-role set (least-privilege) ---
// AUTHORITATIVE parse of the EXPLICIT EXAMINATION_CREATE_SEED_BUNDLES block (NOT
// the best-effort global tally above). The directive pins exactly SIX explicit role
// grants and NO more: super_admin is PLATFORM-tier (platform:* namespace only) and
// does NOT receive the tenant ATS scope examination:create — PG seed-scrub confirms
// the +6 grant delta (734→740). back_office + delivery_manager MUST be excluded (they
// hold examination:read but not submittal:create — no create authority).
const EXAM_CREATE_EXPECTED_EXPLICIT = [
  'account_manager',
  'lead_recruiter',
  'recruiter',
  'recruiting_manager',
  'tenant_admin',
  'tenant_owner',
].sort();
const EXAM_CREATE_EXCLUDED = ['back_office', 'delivery_manager'];
const nameAt = wholeSeed.indexOf('EXAMINATION_CREATE_SEED_BUNDLES');
const eqAt = nameAt >= 0 ? wholeSeed.indexOf('= [', nameAt) : -1;
const openAt = eqAt >= 0 ? wholeSeed.indexOf('[', eqAt) : -1;
const endAt = openAt >= 0 ? wholeSeed.indexOf('];', openAt) : -1;
if (openAt < 0 || endAt < 0) {
  fail('EXAMINATION_CREATE_SEED_BUNDLES value block not found');
} else {
  const block = wholeSeed.slice(openAt, endAt);
  const explicitRoles = [...block.matchAll(/\[\s*'([a-z_]+)'\s*,/g)]
    .map((m) => m[1])
    .sort();
  if (JSON.stringify(explicitRoles) !== JSON.stringify(EXAM_CREATE_EXPECTED_EXPLICIT)) {
    fail(
      `examination:create explicit bundle roles ${JSON.stringify(explicitRoles)} != expected ${JSON.stringify(EXAM_CREATE_EXPECTED_EXPLICIT)}`,
    );
  }
  for (const r of EXAM_CREATE_EXCLUDED) {
    if (explicitRoles.includes(r)) {
      fail(`examination:create must EXCLUDE ${r} (least-privilege: read-only, no create authority)`);
    }
  }
  if (!idMap.has('examination:create')) {
    fail('examination:create absent from the scope id-map');
  }
  console.log(
    `examination:create explicit bundle (${explicitRoles.length}): ${explicitRoles.join(', ')}`,
  );
  console.log(
    `examination:create authorized set = 6 explicit roles (super_admin is platform-tier, NOT a holder); excluded: ${EXAM_CREATE_EXCLUDED.join(', ')}`,
  );
}

if (process.exitCode === 1) console.error('scope-catalog consistency: FAIL');
else console.log('scope-catalog consistency: PASS');
