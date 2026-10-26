import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PLATFORM_OWNER_BOOTSTRAP_EVENT } from '../lib/commercial/commercial-platform-owner-bootstrap.js';
import { ccpFactCheck, formatFactCheck } from '../lib/commercial/ccp-fact-check.js';
import { formatBackfillPlan, planPreCcpBackfill } from '../lib/commercial/pre-ccp-backfill.js';

import { applyCcpA6Schema, humanRef } from './support/ccp-a3-database.js';
import { BOOTSTRAP_OPERATOR_ID, addBootstrapOperator, count, footprint } from './support/ccp-a9-database.js';

// CCP-FIX1 item 1 (D5-DEF-3): every CCP operator script that package.json runs through
// deploy/jiti-tsconfig-runner.mjs, invoked through the REAL runner (`node deploy/jiti-tsconfig-runner.mjs
// <entry> …`, exactly the `npm run` command line) against one testcontainer carrying the full chain.
// Each script: one valid invocation succeeds, one invalid invocation is refused with its documented
// exit code and writes nothing. The runner puts the entry path at argv[2]; a script that parsed
// argv.slice(2) as its own arguments (the bootstrap before FIX1) refused every invocation.

const REPO_ROOT = resolve(__dirname, '../../../..');
const RUNNER = resolve(REPO_ROOT, 'deploy/jiti-tsconfig-runner.mjs');
const run = promisify(execFile);

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-FIX1 operator scripts through the real jiti runner (real Postgres 17)', { timeout: 300_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let url: string;

  async function script(entry: string, args: readonly string[], env: Record<string, string | undefined> = {}): Promise<Outcome> {
    try {
      const r = await run('node', [RUNNER, entry, ...args], { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: url, ...env }, timeout: 120_000 });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      if (typeof err.code !== 'number') throw e;
      return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpA6Schema(pg);
    await addBootstrapOperator(pg);
  }, 300_000);

  afterAll(async () => {
    await pg?.end();
    await container?.stop();
  }, 60_000);

  const BOOTSTRAP = 'libs/subscription/scripts/ccp-bootstrap-platform-owner.ts';

  it('FIX1-RUN-1 ccp:bootstrap-platform-owner: an invalid invocation through the runner is refused INVALID_ARGUMENT (exit 2) naming the bad flag, never the entry path, and writes nothing', async () => {
    const before = await footprint(pg);
    const unknown = await script(BOOTSTRAP, ['--po-authorization-ref', 'PO-AUTH-FIX1', '--human-ref-hash', humanRef('human:purush'), '--user', 'someone@else']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('REFUSED: INVALID_ARGUMENT');
    expect(unknown.stderr).toContain('"unknown_argument":"--user"');
    expect(unknown.stderr).not.toContain('ccp-bootstrap-platform-owner.ts');
    const missing = await script(BOOTSTRAP, ['--po-authorization-ref', 'PO-AUTH-FIX1']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('"missing_argument":"--human-ref-hash"');
    const badHash = await script(BOOTSTRAP, ['--po-authorization-ref', 'PO-AUTH-FIX1', '--human-ref-hash', 'not-a-hash']);
    expect(badHash.code).toBe(2);
    expect(badHash.stderr).toContain('"argument":"human_ref_hash"');
    expect(await footprint(pg)).toEqual(before);
  });

  it('FIX1-RUN-2 ccp:bootstrap-platform-owner: a valid invocation through the runner grants platform_owner (exit 0, one audit event); a re-run is a no-op (exit 0, nothing written)', async () => {
    const granted = await script(BOOTSTRAP, ['--po-authorization-ref', 'PO-AUTH-FIX1', '--human-ref-hash', humanRef('human:purush')]);
    expect(granted.stderr).toBe('');
    expect(granted.code).toBe(0);
    expect(granted.stdout).toContain(`[ccp-bootstrap] granted platform_owner to ${BOOTSTRAP_OPERATOR_ID}`);
    expect(await count(pg, `SELECT count(*)::int AS n FROM subscription."CommercialAuditEvent" WHERE event_type = $1`, [PLATFORM_OWNER_BOOTSTRAP_EVENT])).toBe(1);
    expect(
      await count(
        pg,
        `SELECT count(*)::int AS n FROM identity."UserTenantMembershipRole" mr JOIN identity."UserTenantMembership" m ON m.id = mr.membership_id JOIN identity."Role" r ON r.id = mr.role_id WHERE m.user_id = $1 AND r.key = 'platform_owner'`,
        [BOOTSTRAP_OPERATOR_ID],
      ),
    ).toBe(1);
    const after = await footprint(pg);
    const again = await script(BOOTSTRAP, ['--po-authorization-ref=PO-AUTH-FIX1', `--human-ref-hash=${humanRef('human:purush')}`]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('no-op');
    expect(await footprint(pg)).toEqual(after);
  });

  it('FIX1-RUN-3 usage:rollup: --reconcile-only runs through the runner (read-only; status line printed); --reconcile-only with --rebuild is refused (exit 2)', async () => {
    const before = await count(pg, `SELECT count(*)::int AS n FROM subscription."UsageRollupRun"`);
    const ok = await script('libs/subscription/prisma/usage-rollup.ts', ['--reconcile-only']);
    expect(ok.stderr).toBe('');
    expect(ok.stdout).toMatch(/\[usage-rollup\] (RECONCILED|NOT_RECONCILED|NOT_RUN)\n$/);
    expect(ok.code).toBe(ok.stdout.endsWith('[usage-rollup] RECONCILED\n') ? 0 : 1);
    expect(await count(pg, `SELECT count(*)::int AS n FROM subscription."UsageRollupRun"`)).toBe(before);
    const bad = await script('libs/subscription/prisma/usage-rollup.ts', ['--reconcile-only', '--rebuild']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('exclusive');
  });

  it('FIX1-RUN-4 billing:cutover-check: runs through the runner (exit 0, no conflicting intent on this fixture); without DATABASE_URL it is refused (exit 2)', async () => {
    const ok = await script('libs/subscription/prisma/check-checkout-cutover.ts', []);
    expect(ok.stderr).toBe('');
    expect(ok.code).toBe(0);
    const bad = await script('libs/subscription/prisma/check-checkout-cutover.ts', [], { DATABASE_URL: '' });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('set DATABASE_URL');
  });

  it('FIX1-RUN-5 billing:price-parity: runs through the runner (an empty STRIPE_PLAN_PRICES is parity, exit 0); without DATABASE_URL it is refused (exit 2)', async () => {
    const ok = await script('libs/subscription/prisma/check-provider-price-parity.ts', ['--strict'], { STRIPE_PLAN_PRICES: '' });
    expect(ok.stderr).toBe('');
    expect(ok.stdout).toContain('(strict mode)');
    expect(ok.code).toBe(ok.stdout.includes('[price-parity] OK') ? 0 : 1);
    const bad = await script('libs/subscription/prisma/check-provider-price-parity.ts', [], { DATABASE_URL: '' });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('set DATABASE_URL');
  });

  it('FIX1-RUN-6 ccp:astre-backfill: --dry-run through the runner prints the plan byte for byte; no --dry-run is refused (exit 2)', async () => {
    const plan = await planPreCcpBackfill(pg);
    const ok = await script('libs/subscription/prisma/ccp-astre-backfill.ts', ['--dry-run']);
    expect(ok.code).toBe(plan.halt ? 1 : 0);
    expect(ok.stdout.trimEnd().split('\n')).toEqual(formatBackfillPlan(plan));
    const bad = await script('libs/subscription/prisma/ccp-astre-backfill.ts', []);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('REFUSED');
  });

  it('FIX1-RUN-7 ccp:astre-fact-check: runs through the runner (exit 0, the report); a non-local URL without --po-authorization-ref is refused (exit 2)', async () => {
    const ok = await script('libs/subscription/prisma/ccp-astre-fact-check.ts', ['--database-url', url], { DATABASE_URL: '' });
    expect(ok.code).toBe(0);
    expect(ok.stdout.trimEnd().split('\n')).toEqual(formatFactCheck(await ccpFactCheck(pg)));
    const remote = url.replace(/@[^:/]+(:\d+)?\//, '@db.prod.example:5432/');
    const bad = await script('libs/subscription/prisma/ccp-astre-fact-check.ts', ['--database-url', remote], { DATABASE_URL: '' });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('REFUSED');
  });
});
