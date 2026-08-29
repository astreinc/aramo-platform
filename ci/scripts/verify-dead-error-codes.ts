// HYG-3 — dead-error-code guard.
//
// Every code in the ERROR_CODES registry (libs/common/src/lib/errors/error-codes.ts)
// must be EITHER:
//   (a) EMITTED — referenced somewhere reachable outside the 4 registry/parity
//       sites (a throw/AramoError site, a port union type, an FE error-code map), OR
//   (b) COMPATIBILITY_RESERVED — an explicit machine-classified reservation in
//       RESERVED_CODES below, with a reason. (e.g. REQUISITION_NO_OPENINGS.)
//
// A code that is neither emitted nor machine-classified is DEAD residue → CI fails.
// This is a MACHINE-governed classification: a prose comment near the code is NOT
// sufficient (per the Architect's HYG-3 principle — no heuristic comment-guessing).
//
// Run:       node --import jiti/register ci/scripts/verify-dead-error-codes.ts
// Self-test: SELF_TEST=1 node --import jiti/register ci/scripts/verify-dead-error-codes.ts

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, '..', '..');
const REGISTRY_TS = join(REPO_ROOT, 'libs', 'common', 'src', 'lib', 'errors', 'error-codes.ts');

// The four registry/parity sites where a code appears BY DEFINITION (not by
// emission). A code appearing ONLY in these is not "used".
const REGISTRY_SITES = [
  'libs/common/src/lib/errors/error-codes.ts',
  'libs/common/src/lib/errors/aramo-error.ts',
  'libs/common/src/tests/error-codes.spec.ts',
  'openapi/common.yaml',
];

// COMPATIBILITY_RESERVED — codes deliberately retained without a live emitter.
// Each MUST carry a reason. This is the machine-detectable exemption the Architect
// requires (not a prose comment the guard would have to interpret).
export const RESERVED_CODES: Record<string, string> = {
  REQUISITION_NO_OPENINGS:
    'RESERVED (T4-B2 §7): the pipeline over-capacity refusal was retired (capacity is now derived), but the code is kept for compatibility — still mapped by the ats-web pipeline error-message map.',
  PIPELINE_SUBMIT_REQUIRES_SUBMITTAL:
    'RESERVED (Lane 2 / L2-E, SB-5): the Pipeline `submitted` mirror was retired — a bare transition to `submitted` now falls through to INVALID_PIPELINE_TRANSITION (422). The code is kept (registry is append-only; dropping it risks the merge-window append-conflict class) as deprecated/reserved with no throw-site.',
};

export function extractRegistry(source: string): string[] {
  const m = source.match(/export\s+const\s+ERROR_CODES\s*=\s*\[([\s\S]*?)\]\s*as\s+const\s*;/);
  if (m === null || m[1] === undefined) {
    throw new Error(`could not locate ERROR_CODES tuple in ${REGISTRY_TS}`);
  }
  return [...m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((mm) => mm[1]!);
}

export interface Issue {
  code: string;
  reason: string;
}

// Pure classifier: an issue iff a code is neither emitted nor reserved.
export function verify(
  codes: string[],
  emitted: ReadonlySet<string>,
  reserved: Record<string, string>,
): Issue[] {
  const issues: Issue[] = [];
  for (const c of codes) {
    if (emitted.has(c)) continue;
    if (Object.prototype.hasOwnProperty.call(reserved, c)) {
      if (!reserved[c] || reserved[c]!.trim().length === 0) {
        issues.push({ code: c, reason: `reserved but no reason given` });
      }
      continue;
    }
    issues.push({
      code: c,
      reason: `DEAD: no emitter found and not COMPATIBILITY_RESERVED. Either add a throw-site or add a RESERVED_CODES entry with a reason.`,
    });
  }
  return issues;
}

// Grep the repo for each code as a quoted literal, excluding the registry sites.
// A hit outside those sites = the code is emitted/consumed somewhere reachable.
function findEmitted(codes: string[]): Set<string> {
  const emitted = new Set<string>();
  const excludes = REGISTRY_SITES.map((p) => `:(exclude)${p}`);
  for (const c of codes) {
    try {
      const out = execSync(
        `git -C ${REPO_ROOT} grep -l -F -e "'${c}'" -- 'apps/**' 'libs/**' ${excludes
          .map((e) => `'${e}'`)
          .join(' ')}`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      if (out.trim().length > 0) emitted.add(c);
    } catch {
      // git grep exits 1 when no match — code not emitted anywhere outside registry.
    }
  }
  return emitted;
}

function checkRepo(): Issue[] {
  const codes = extractRegistry(readFileSync(REGISTRY_TS, 'utf8'));
  const emitted = findEmitted(codes);
  return verify(codes, emitted, RESERVED_CODES);
}

function runSelfTest(): void {
  const emitted = new Set(['EMITTED_CODE']);
  const reserved = { RESERVED_ONE: 'kept for compatibility' };

  // Clean: emitted + reserved both pass.
  const ok = verify(['EMITTED_CODE', 'RESERVED_ONE'], emitted, reserved);
  if (ok.length !== 0) throw new Error(`self-test: clean set flagged: ${JSON.stringify(ok)}`);

  // NEGATIVE: a registered-but-unemitted code with no reservation MUST fail.
  const dead = verify(['FAKE_DEAD_CODE'], emitted, reserved);
  if (!dead.some((i) => i.code === 'FAKE_DEAD_CODE' && i.reason.startsWith('DEAD'))) {
    throw new Error('self-test: dead code NOT flagged — guard does not protect the invariant');
  }

  // POSITIVE: the same code, once explicitly reserved with a reason, passes.
  const nowReserved = verify(['FAKE_DEAD_CODE'], emitted, { FAKE_DEAD_CODE: 'reserved for X' });
  if (nowReserved.length !== 0) {
    throw new Error('self-test: explicitly-reserved code wrongly flagged');
  }

  // A reservation with an empty reason is rejected.
  const noReason = verify(['FAKE_DEAD_CODE'], emitted, { FAKE_DEAD_CODE: '' });
  if (!noReason.some((i) => i.reason.includes('no reason'))) {
    throw new Error('self-test: empty-reason reservation not flagged');
  }

  console.log('self-test ok: dead-error-code guard flags unemitted+unreserved, passes emitted/reserved');
}

function main(): void {
  if (process.env['SELF_TEST'] === '1' || process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }
  const issues = checkRepo();
  if (issues.length === 0) {
    console.log('dead-error-codes:check ok');
    return;
  }
  console.error(`dead-error-codes:check FAILED — ${issues.length} dead/unclassified code(s):`);
  for (const i of issues) console.error(`  ${i.code}: ${i.reason}`);
  process.exit(1);
}

main();
