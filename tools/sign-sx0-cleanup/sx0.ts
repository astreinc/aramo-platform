// SX-0 clean start of standalone Aramo Sign data — command line. See RUNBOOK.md.
//
//   node --import jiti/register tools/sign-sx0-cleanup/sx0.ts <mode> [options]
//
// Modes (DATABASE_URL is required by every mode except s3-execute's S3 half):
//   inventory     read-only. --tenant <uuid> [--out <file>]
//                 Writes the frozen manifest (JSON) and prints its SHA-256.
//   s3-inventory  read-only. --manifest <file> --bucket <name> [--out <file>]
//                 ListObjectVersions under esign/source/<tenant>/ and writes the S3 manifest.
//   dry-run       --tenant <uuid> [--manifest <file>]
//                 The full deletion in one transaction, then ROLLBACK. Prints before/after.
//   execute       --manifest <file> --manifest-sha256 <hex> --confirm-tenant <uuid>
//                 env SX0_EXECUTION_AUTHORIZED=<manifest sha>. One transaction, COMMIT.
//   s3-execute    --s3-manifest <file> --s3-manifest-sha256 <hex> --bucket <name>
//                 env SX0_S3_EXECUTION_AUTHORIZED=<s3 manifest sha>. Admin principal only.
//
// LC-2: production execution (execute, s3-execute) is NOT authorized by the directive.

import { readFileSync, writeFileSync } from 'node:fs';

import { Client } from 'pg';

import {
  type Manifest,
  type S3Manifest,
  type S3Port,
  Sx0Refusal,
  assertExecutionAuthorized,
  assertS3ExecutionAuthorized,
  assertS3KeysUnreferenced,
  assertUuid,
  buildInventory,
  buildS3Inventory,
  executeS3Deletes,
  makeManifest,
  runWipe,
  verifyManifestFile,
} from './sx0.lib.js';

function parseArgs(argv: string[]): { mode: string; opts: Record<string, string> } {
  const [mode = '', ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i] ?? '';
    if (!a.startsWith('--')) throw new Sx0Refusal('BAD_ARGUMENT', `unexpected argument ${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Sx0Refusal('BAD_ARGUMENT', `${a} needs a value`);
    opts[a.slice(2)] = v;
    i += 1;
  }
  return { mode, opts };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function emit(out: string | undefined, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (out !== undefined) writeFileSync(out, text, { mode: 0o600 });
  else process.stdout.write(text);
}

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') throw new Sx0Refusal('BAD_ARGUMENT', 'DATABASE_URL is not set');
  const db = new Client({ connectionString: url, application_name: 'aramo-sign-sx0' });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function s3Client(): Promise<S3Port> {
  const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' });
  return {
    listObjectVersions: (input) => client.send(new ListObjectVersionsCommand(input)),
    deleteObjects: (input) => client.send(new DeleteObjectsCommand(input)),
  };
}

export async function main(argv: string[]): Promise<number> {
  const { mode, opts } = parseArgs(argv);
  switch (mode) {
    case 'inventory': {
      const tenant = opts['tenant'] ?? null;
      assertUuid(tenant, '--tenant');
      const m = await withDb(async (db) => {
        await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const inv = await buildInventory(db, tenant);
          return makeManifest(inv.body, inv.report);
        } finally {
          await db.query('ROLLBACK');
        }
      });
      emit(opts['out'], m);
      process.stderr.write(`sx0 inventory: ${m.body.envelopes.length} standalone envelope(s); manifest_sha256=${m.manifest_sha256}\n`);
      return 0;
    }
    case 's3-inventory': {
      const manifestPath = opts['manifest'];
      const bucket = opts['bucket'];
      if (manifestPath === undefined || bucket === undefined) throw new Sx0Refusal('BAD_ARGUMENT', 's3-inventory needs --manifest and --bucket');
      const m = readJson<Manifest>(manifestPath);
      verifyManifestFile(m, m.manifest_sha256);
      const s3 = await s3Client();
      const sm = await withDb(async (db) => {
        await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          return await buildS3Inventory(db, s3, m, bucket);
        } finally {
          await db.query('ROLLBACK');
        }
      });
      emit(opts['out'], sm);
      process.stderr.write(`sx0 s3-inventory: ${sm.body.version_count} version(s) + ${sm.body.delete_marker_count} delete marker(s); s3_manifest_sha256=${sm.s3_manifest_sha256}\n`);
      return 0;
    }
    case 'dry-run': {
      const tenant = opts['tenant'] ?? null;
      assertUuid(tenant, '--tenant');
      const manifest = opts['manifest'] !== undefined ? readJson<Manifest>(opts['manifest']) : undefined;
      if (manifest !== undefined) verifyManifestFile(manifest, manifest.manifest_sha256);
      const r = await withDb((db) => runWipe(db, { mode: 'dry-run', tenant, manifest }));
      emit(opts['out'], r);
      process.stderr.write(`sx0 dry-run: rolled back; would delete ${r.deleted.find((d) => d.table === 'SignatureEnvelope')?.rows ?? 0} envelope(s); live inventory sha=${r.manifest_sha256}\n`);
      return 0;
    }
    case 'execute': {
      const path = opts['manifest'];
      if (path === undefined) throw new Sx0Refusal('BAD_ARGUMENT', 'execute needs --manifest');
      const manifest = readJson<Manifest>(path);
      assertExecutionAuthorized({ manifest, manifestSha256: opts['manifest-sha256'], confirmTenant: opts['confirm-tenant'], env: process.env });
      const r = await withDb((db) => runWipe(db, { mode: 'execute', tenant: manifest.body.tenant_filter, manifest }));
      emit(opts['out'], r);
      process.stderr.write(`sx0 execute: COMMITTED manifest ${r.manifest_sha256}\n`);
      return 0;
    }
    case 's3-execute': {
      const path = opts['s3-manifest'];
      if (path === undefined) throw new Sx0Refusal('BAD_ARGUMENT', 's3-execute needs --s3-manifest');
      const sm = readJson<S3Manifest>(path);
      assertS3ExecutionAuthorized({ manifest: sm, manifestSha256: opts['s3-manifest-sha256'], bucket: opts['bucket'], env: process.env });
      await withDb((db) => assertS3KeysUnreferenced(db, sm));
      const r = await executeS3Deletes(await s3Client(), sm);
      emit(opts['out'], r);
      process.stderr.write(`sx0 s3-execute: ${r.deleted.length}/${r.requested} deleted, ${r.errors.length} error(s)\n`);
      return r.errors.length === 0 && r.deleted.length === r.requested ? 0 : 1;
    }
    default:
      throw new Sx0Refusal('BAD_ARGUMENT', `unknown mode "${mode}" (inventory | s3-inventory | dry-run | execute | s3-execute)`);
  }
}

if (process.argv[1] !== undefined && /sx0\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`sx0: REFUSED/FAILED — ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    },
  );
}
