import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { parseFactCheckArgs } from '../lib/commercial/ccp-fact-check.js';
import { BackfillRefusedError, deterministicUuid, isLocalDatabaseUrl, parseBackfillArgs, recordIdFor } from '../lib/commercial/pre-ccp-backfill.js';

// CCP-A11 (PBD §5.1 row A11) — the refusal guards, without any database: the backfill refuses
// without --dry-run, refuses --execute, and refuses any URL that is not localhost / a
// testcontainer; the fact-check refuses a non-local URL without a PO authorization reference.
// Test IDs are cited by doc/ccp/slices/CCP-A11-acceptance.md.

const REPO_ROOT = resolve(__dirname, '../../../..');
const run = promisify(execFile);
const LOCAL = 'postgres://test:test@localhost:55432/test';

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof BackfillRefusedError) return e.refusal;
    throw e;
  }
  return 'NOT_REFUSED';
}

describe('CCP-A11 backfill and fact-check refusal guards', () => {
  it('A11-G-1 the backfill requires --dry-run', () => {
    expect(refusal(() => parseBackfillArgs([], { DATABASE_URL: LOCAL }))).toBe('DRY_RUN_REQUIRED');
    expect(refusal(() => parseBackfillArgs(['--database-url', LOCAL], {}))).toBe('DRY_RUN_REQUIRED');
    expect(parseBackfillArgs(['--dry-run'], { DATABASE_URL: LOCAL })).toEqual({ database_url: LOCAL });
    expect(parseBackfillArgs(['--dry-run', `--database-url=${LOCAL}`], {})).toEqual({ database_url: LOCAL });
  });

  it('A11-G-2 --execute is always refused (no execute path), even with --dry-run and a local URL', () => {
    expect(refusal(() => parseBackfillArgs(['--dry-run', '--execute'], { DATABASE_URL: LOCAL }))).toBe('EXECUTE_NOT_AUTHORIZED');
    expect(refusal(() => parseBackfillArgs(['--execute=yes', '--dry-run'], { DATABASE_URL: LOCAL }))).toBe('EXECUTE_NOT_AUTHORIZED');
    expect(refusal(() => parseBackfillArgs(['--dry-run', '--force'], { DATABASE_URL: LOCAL }))).toBe('UNKNOWN_ARGUMENT');
  });

  it('A11-G-3 a URL that is not localhost or a testcontainer is refused; so is a host override or a socket path', () => {
    const remote = [
      'postgres://u:p@db.prod.example:5432/aramo',
      'postgresql://u:p@10.0.0.5:5432/aramo',
      'postgres://u:p@44.216.251.124:5432/aramo',
      'postgres://u:p@localhost.attacker.example:5432/aramo',
      'postgres://u:p@localhost:5432/aramo?host=db.prod.example',
      'postgres://u:p@localhost:5432/aramo?hostaddr=10.0.0.5',
      'postgres://u:p@localhost:5432/aramo?service=prod',
      'postgres://u:p@/aramo?host=/var/run/postgresql',
      'mysql://u:p@localhost:3306/aramo',
      'not a url',
    ];
    for (const u of remote) {
      expect(isLocalDatabaseUrl(u)).toBe(false);
      expect(refusal(() => parseBackfillArgs(['--dry-run', '--database-url', u], {}))).toBe('DATABASE_URL_NOT_LOCAL');
    }
    for (const u of [LOCAL, 'postgresql://u:p@127.0.0.1:5432/x', 'postgres://u:p@[::1]:5432/x', 'postgres://u:p@LOCALHOST:5432/x?sslmode=disable']) expect(isLocalDatabaseUrl(u)).toBe(true);
    expect(refusal(() => parseBackfillArgs(['--dry-run'], {}))).toBe('DATABASE_URL_MISSING');
  });

  it('A11-G-4 the fact-check: a local URL runs; a non-local URL needs --po-authorization-ref (a production read is separately authorized)', () => {
    expect(parseFactCheckArgs([], { DATABASE_URL: LOCAL })).toEqual({ database_url: LOCAL, po_authorization_ref: null });
    expect(refusal(() => parseFactCheckArgs(['--database-url', 'postgres://u:p@db.prod.example/aramo'], {}))).toBe('DATABASE_URL_NOT_LOCAL');
    expect(refusal(() => parseFactCheckArgs(['--database-url', 'postgres://u:p@db.prod.example/aramo', '--po-authorization-ref', '  '], {}))).toBe('DATABASE_URL_NOT_LOCAL');
    expect(parseFactCheckArgs(['--database-url', 'postgres://u:p@db.prod.example/aramo', '--po-authorization-ref', 'PO-2026-XX'], {})).toEqual({
      database_url: 'postgres://u:p@db.prod.example/aramo',
      po_authorization_ref: 'PO-2026-XX',
    });
    expect(refusal(() => parseFactCheckArgs(['--write'], { DATABASE_URL: LOCAL }))).toBe('UNKNOWN_ARGUMENT');
  });

  it('A11-G-5 record ids are deterministic (idempotent re-run by primary key)', () => {
    const s = '0190a11b-0000-7000-8000-00000000a57e';
    expect(recordIdFor(s)).toBe(recordIdFor(s));
    expect(recordIdFor(s)).not.toBe(recordIdFor('0190a11b-0000-7000-8000-00000000e70c'));
    expect(deterministicUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('A11-G-6 the commands exit 2 on every refusal, before connecting (no --dry-run; --execute; a non-local URL; the fact-check without authorization)', { timeout: 120_000 }, async () => {
    const runner = resolve(REPO_ROOT, 'deploy/jiti-tsconfig-runner.mjs');
    const backfill = 'libs/subscription/prisma/ccp-astre-backfill.ts';
    const fact = 'libs/subscription/prisma/ccp-astre-fact-check.ts';
    const cases: Array<[string, string[], RegExp]> = [
      [backfill, ['--database-url', LOCAL], /REFUSED \(DRY_RUN_REQUIRED\)/],
      [backfill, ['--dry-run', '--execute', '--database-url', LOCAL], /REFUSED \(EXECUTE_NOT_AUTHORIZED\)/],
      [backfill, ['--dry-run', '--database-url', 'postgres://u:p@db.prod.example:5432/aramo'], /REFUSED \(DATABASE_URL_NOT_LOCAL\)/],
      [fact, ['--database-url', 'postgres://u:p@db.prod.example:5432/aramo'], /REFUSED \(DATABASE_URL_NOT_LOCAL\)/],
    ];
    for (const [entry, args, message] of cases) {
      const err = await run('node', [runner, entry, ...args], { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: '' } }).then(
        () => null,
        (e: { code: number; stderr: string }) => e,
      );
      expect(err?.code).toBe(2);
      expect(err?.stderr).toMatch(message);
    }
  });
});
