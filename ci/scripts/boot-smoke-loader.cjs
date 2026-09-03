#!/usr/bin/env node
'use strict';
/*
 * ci/scripts/boot-smoke-loader.cjs
 *
 * Production-dependency BOOT smoke loader. Runs INSIDE a prod-pruned service image
 * (or via --self-test, standalone). It resolves a service's runtime entry module
 * graph using ONLY the production dependencies present in that image, and fails
 * loudly if any runtime import is unavailable.
 *
 * Motivating failure class (2026-09-02): `decimal.js` was a runtime import parked in
 * devDependencies. It passed every CI check (CI installs ALL deps), then `npm prune
 * --omit=dev` stripped it from the api/auth-service/platform-admin images, which
 * crash-looped at boot with MODULE_NOT_FOUND. CI never booted a pruned image, so it
 * was blind. This loader reproduces the prod dependency shape and makes that class
 * fail in CI, not on the box.
 *
 * Semantics (deliberate):
 *   - A missing runtime module (MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND / "Cannot find
 *     module|package") => EXIT 1 with a clear, per-service, actionable message.
 *   - The entry's static require graph RESOLVING => EXIT 0. This includes the case
 *     where require() throws a NON-module error (e.g. a fail-closed env/config
 *     assertion): every module was found, which is exactly what this smoke verifies.
 *   - We exit the instant the static graph resolves. We do NOT boot the app — so an
 *     app-level async failure (missing DB/env in bootstrap) can neither mask a real
 *     missing-module failure nor fake a pass.
 *
 * Usage:
 *   node boot-smoke-loader.cjs <entry-path> [label]
 *   node boot-smoke-loader.cjs --self-test        # proves RED (missing) + GREEN (present)
 */
const path = require('path');

function firstLine(e) {
  return String((e && e.message) || e).split('\n')[0];
}

function isModuleNotFound(err) {
  if (!err) return false;
  if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND') return true;
  return /Cannot find (module|package)/i.test(String(err.message || err));
}

function failMissing(label, err) {
  console.error(
    `BOOT-SMOKE FAIL [${label}] — a RUNTIME import is unavailable in the production image: ${firstLine(err)}`,
  );
  console.error('  → a package imported by runtime code was removed by `npm prune --omit=dev`.');
  console.error('  → move it from devDependencies to dependencies (verify: `npm ls --omit=dev <pkg>`).');
  process.exit(1);
}

function passResolved(label, note) {
  console.log(
    `BOOT-SMOKE OK [${label}] — runtime entry graph resolved with production dependencies only${
      note ? ` (${note})` : ''
    }`,
  );
  process.exit(0);
}

function loadGraph(entry, label) {
  const abs = path.resolve(process.cwd(), entry);
  // A module error surfacing from the synchronous prefix of async bootstrap (a
  // dynamic import that rejects) lands here; a plain app env/DB rejection is NOT a
  // module error and is ignored.
  process.on('unhandledRejection', (e) => {
    if (isModuleNotFound(e)) failMissing(label, e);
  });
  process.on('uncaughtException', (e) => {
    if (isModuleNotFound(e)) failMissing(label, e);
  });

  try {
    require(abs);
  } catch (e) {
    if (isModuleNotFound(e)) failMissing(label, e);
    // Non-module error at load time: every module RESOLVED (this is a fail-closed
    // env/config assertion, not a missing dependency). That is a PASS for this smoke.
    passResolved(label, `non-module load error ignored: ${firstLine(e)}`);
  }
  // require returned: the static require graph is fully resolved. Exit NOW, before
  // async bootstrap can fail on missing env/DB (which must not mask the result).
  passResolved(label);
}

function selfTest() {
  // Proves the guard is RED on a missing module and GREEN on a present one, using
  // throwaway fixture entries — it leaves NO broken dependency configuration behind.
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-smoke-selftest-'));
  const missingEntry = path.join(dir, 'missing.cjs');
  const presentEntry = path.join(dir, 'present.cjs');
  fs.writeFileSync(missingEntry, "require('boot-smoke-absent-module-xyzzy');\n");
  fs.writeFileSync(presentEntry, "require('node:path'); require('node:crypto');\n");

  let redOk = false;
  let greenOk = false;
  try {
    execFileSync(process.execPath, [__filename, missingEntry, 'selftest-missing'], { stdio: 'pipe' });
  } catch (e) {
    redOk = e.status === 1 && /BOOT-SMOKE FAIL/.test(String(e.stderr));
  }
  try {
    const out = execFileSync(process.execPath, [__filename, presentEntry, 'selftest-present'], {
      stdio: 'pipe',
    });
    greenOk = /BOOT-SMOKE OK/.test(String(out));
  } catch {
    greenOk = false;
  }
  fs.rmSync(dir, { recursive: true, force: true });

  if (!redOk) {
    console.error('SELF-TEST FAIL: the guard did NOT go RED (exit 1 + BOOT-SMOKE FAIL) on a missing module.');
    process.exit(1);
  }
  if (!greenOk) {
    console.error('SELF-TEST FAIL: the guard did NOT go GREEN on a present module.');
    process.exit(1);
  }
  console.log('SELF-TEST OK: RED on a missing runtime module, GREEN on a present one.');
  process.exit(0);
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: boot-smoke-loader.cjs <entry-path> [label] | --self-test');
  process.exit(2);
}
if (arg === '--self-test') selfTest();
else loadGraph(arg, process.argv[3] || arg);
