import { execSync } from 'node:child_process';

import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import {
  TenantResetService,
  ResetBatchStore,
  PrismaService,
  FileArchiveSink,
  type PgExec,
  type ResetOptions,
  type ResetReport,
} from '@aramo/tenant-reset';

// Track-0 (Tenant Reset & Archive, Directive v1.0 LOCKED) — the
// `tenant-reset` admin CLI. NO HTTP surface. It permanently destroys
// requisition-domain data for ONE explicitly-supplied tenant, after
// archiving and verifying it, and records an append-only ResetBatch.
//
// >> This tool permanently destroys production data. It is built and
// >> tested against CONTROLLED DATA ONLY. Production execution is a
// >> SEPARATE PO approval (§8). Nothing here authorises touching Astre.
//
// DRY-RUN IS THE DEFAULT (§4). A real run needs THREE independent inputs
// so no single mistake destroys data: the `--execute` flag, the tenant id
// re-typed as a confirmation string, AND a recorded `--approved-by`. The
// production DATABASE_URL is supplied at run time from the approved Mac —
// never in source, this file, or any commit (§4).
//
// Usage (after build):
//   node dist/apps/api/src/tenant-reset/tenant-reset.command.js \
//     <tenant_id> --approved-by "<human>" [--archive <path>]
//   node dist/apps/api/src/tenant-reset/tenant-reset.command.js \
//     <tenant_id> --approved-by "<human>" --archive <path> \
//     --execute <tenant_id-as-confirmation> [--override]

interface Args {
  tenantId?: string;
  approvedBy?: string;
  archive?: string;
  execute: boolean;
  confirm?: string;
  override: boolean;
  commit?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { execute: false, override: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--approved-by':
        out.approvedBy = argv[++i];
        break;
      case '--archive':
        out.archive = argv[++i];
        break;
      case '--execute':
        out.execute = true;
        out.confirm = argv[++i];
        break;
      case '--override':
        out.override = true;
        break;
      case '--commit':
        out.commit = argv[++i];
        break;
      default:
        if (a !== undefined) positional.push(a);
    }
  }
  out.tenantId = positional[0];
  return out;
}

function resolveCommit(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const env = process.env['ARAMO_EXECUTION_COMMIT'];
  if (env !== undefined && env.length > 0) return env;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function printReport(logger: Logger, r: ResetReport): void {
  logger.log(`tenant-reset [${r.mode}] tenant=${r.tenant_id} reason=${r.reason} result=${r.result}`);
  logger.log(`  approver=${r.approved_by} commit=${r.execution_commit} batch=${r.batch_id ?? '(none)'}`);
  logger.log(
    `  scope: ${r.scope.requisition_ids.length} requisition(s), ${r.scope.pipeline_ids.length} pipeline(s)`,
  );
  logger.log(`  Activity scoping predicate (verbatim): ${r.activity_predicate}`);
  logger.log(`  freeze: engaged=${r.freeze_engaged} released=${r.freeze_released}`);
  logger.log(
    `  archive: ${r.archive_location ?? '(none — dry run writes no archive)'} ` +
      `checksum=${r.archive_checksum ?? '(none)'} verified=${r.archive_verified}`,
  );
  const verb = r.mode === 'dry-run' ? 'would-delete' : 'deleted';
  for (const d of r.deleted) {
    logger.log(`  DELETE ${d.label}: ${d.before} ${verb}${d.after !== null ? ` (after=${d.after})` : ''}`);
  }
  for (const p of r.preserved) {
    logger.log(`  PRESERVE ${p.label}: ${p.before}${p.after !== null ? ` (after=${p.after})` : ''}`);
  }
  const u = r.usage_event_check;
  logger.log(
    `  UsageEvent: retained=${u.retained_count} dangling=${u.dangling_refs} explainable=${u.explainable}` +
      (u.missing_snapshot_fields.length > 0
        ? ` [substrate lacks enumerated snapshot field(s): ${u.missing_snapshot_fields.join(', ')} — divergence, see PR]`
        : ''),
  );
  for (const o of r.orphan_checks) logger.log(`  ORPHAN ${o.label}: ${o.remaining} remaining`);
  for (const n of r.notes) logger.log(`  NOTE: ${n}`);
}

async function main(): Promise<void> {
  const logger = new Logger('TenantReset');
  const args = parseArgs(process.argv.slice(2));

  if (args.tenantId === undefined || args.tenantId.trim().length === 0) {
    logger.error(
      'usage: tenant-reset <tenant_id> --approved-by "<human>" [--archive <path>] ' +
        '[--execute <tenant_id-as-confirmation>] [--override] [--commit <sha>]',
    );
    process.exitCode = 1;
    return;
  }
  if (args.approvedBy === undefined || args.approvedBy.trim().length === 0) {
    logger.error('--approved-by "<human>" is required — a reset records the human who authorised it (§2.1)');
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    logger.error('DATABASE_URL is required (supplied at run time from the approved Mac — never from source, §4)');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const pg: PgExec = {
    async query<T>(sql: string, params?: unknown[]) {
      const res = await client.query(sql, params as unknown[] | undefined);
      return { rows: res.rows as T[], rowCount: res.rowCount };
    },
  };
  const prisma = new PrismaService(databaseUrl);
  const store = new ResetBatchStore(prisma);
  const svc = new TenantResetService(store, new FileArchiveSink());

  const opts: ResetOptions = {
    tenantId: args.tenantId,
    approvedBy: args.approvedBy,
    executionCommit: resolveCommit(args.commit),
    archiveLocation: args.archive,
    overrideCompletedRun: args.override,
  };

  try {
    if (args.execute) {
      if (args.confirm !== args.tenantId) {
        logger.error(
          'confirmation mismatch: to --execute, re-type the tenant id as the value of --execute',
        );
        process.exitCode = 1;
        return;
      }
      logger.warn(
        'EXECUTE requested — this PERMANENTLY destroys requisition-domain data for the tenant. ' +
          'There is no undo; rollback is archive restoration BEFORE new writes resume (§4).',
      );
      const report = await svc.execute(pg, opts);
      printReport(logger, report);
      if (report.result !== 'COMPLETED') process.exitCode = 1;
    } else {
      const report = await svc.dryRun(pg, opts);
      printReport(logger, report);
      logger.log(
        `DRY-RUN complete — ZERO mutations. Re-run with '--archive <path> --execute ${args.tenantId}' ` +
          `and '--approved-by' to destroy.`,
      );
    }
  } finally {
    await client.end();
    // onModuleDestroy() is the lib's declared lifecycle hook (it calls
    // $disconnect internally); $disconnect is inherited from PrismaClient
    // and not surfaced on the emitted PrismaService .d.ts.
    await prisma.onModuleDestroy();
  }
}

void main();
