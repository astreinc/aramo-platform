import { Logger } from '@nestjs/common';
import { Client } from 'pg';

import {
  TalentErasureService,
  type PgExec,
  type S3Deleter,
  type ErasureReport,
} from '../talent-identity/talent-erasure.service.js';

// TR-15 B2 (DDR §5) — the `erase-talent` admin CLI. NO HTTP surface. Automates
// doc/runbooks/talent-rtbf-erasure.md: resolve the whole human (husk chain +
// trust cluster), delete every PII holder child-before-parent, delete the S3
// blobs (stubbed — the app path has no DeleteObject IAM; the operator does it
// with elevated creds per the runbook), append the retained consent erasure
// marker, and flip is_anonymized.
//
// DRY-RUN IS THE DEFAULT (a per-table would-delete inventory + the husk chain,
// ZERO writes). The live run requires BOTH `--execute` AND typing the record id
// again as a confirmation string. Idempotent: a re-run over an erased human
// reports empty.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/erase-talent.command.js <tenant_id> <record_id>
//   node dist/apps/api/src/talent-anchor/erase-talent.command.js <tenant_id> <record_id> --execute <record_id>
async function main(): Promise<void> {
  const logger = new Logger('EraseTalent');
  const tenantId = process.argv[2];
  const recordId = process.argv[3];
  const execFlag = process.argv[4];
  const confirm = process.argv[5];

  if (
    tenantId === undefined ||
    recordId === undefined ||
    tenantId.trim().length === 0 ||
    recordId.trim().length === 0
  ) {
    logger.error(
      'usage: erase-talent <tenant_id> <record_id> [--execute <record_id-as-confirmation>]',
    );
    process.exitCode = 1;
    return;
  }

  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    logger.error('DATABASE_URL is required');
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const pg: PgExec = {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    },
  };
  const svc = new TalentErasureService();

  try {
    if (execFlag === '--execute') {
      if (confirm !== recordId) {
        logger.error(
          'confirmation mismatch: to --execute, re-type the record id as the final argument',
        );
        process.exitCode = 1;
        return;
      }
      // The S3 deleter is a log-only stub: the app has no DeleteObject IAM, so
      // an operator (or a future injected deleter) removes every version +
      // delete-marker per the runbook. The DB erase is authoritative here.
      const s3Delete: S3Deleter = async (keys) => {
        logger.warn(
          `erase-talent: S3 STUB — ${keys.length} object key(s) require operator deletion ` +
            `(versions + delete-markers) per doc/runbooks/talent-rtbf-erasure.md: ${JSON.stringify(keys)}`,
        );
      };
      const report = await svc.execute(pg, tenantId, recordId, s3Delete);
      printReport(logger, report);
      logger.log(
        `erase-talent EXECUTED: ${report.total_rows} row(s) deleted across ${report.steps.length} table(s); ` +
          `marker_appended=${report.erasure_marker_appended}; is_anonymized flips true; ` +
          `audit RETAINED (${report.retained.join(', ')}).`,
      );
    } else {
      const report = await svc.dryRun(pg, tenantId, recordId);
      printReport(logger, report);
      logger.log(
        `erase-talent DRY-RUN — ${report.total_rows} row(s) WOULD delete; ZERO writes. ` +
          `Re-run with '--execute ${recordId}' to erase.`,
      );
    }
  } finally {
    await client.end();
  }
}

function printReport(logger: Logger, report: ErasureReport): void {
  logger.log(
    `erase-talent [${report.mode}] tenant=${report.tenant_id} record=${report.record_id}`,
  );
  logger.log(
    `  scope: ${report.scope.record_ids.length} record(s) (husk chain), ` +
      `${report.scope.subject_ids.length} trust subject(s), ` +
      `${report.scope.s3_keys.length} S3 object(s)`,
  );
  for (const s of report.steps) {
    const verb = report.mode === 'dry-run' ? 'would-delete' : s.status;
    logger.log(`  ${s.table}: ${s.count} ${verb}${s.error ? ` [error: ${s.error}]` : ''}`);
  }
  logger.log(`  RETAINED (audit, not deleted): ${report.retained.join(', ')}`);
  // TR-2b B2b — the identity-cluster last-reference section.
  const cp = report.cluster_purge;
  const clusterVerb = report.mode === 'dry-run' ? 'would-purge' : 'purged';
  logger.log(
    `  clusters: ${cp.captured_cluster_ids.length} referenced, ` +
      `${cp.orphaned_cluster_ids.length} orphaned → ${clusterVerb}` +
      (cp.orphaned_cluster_ids.length > 0
        ? ` [${cp.orphaned_cluster_ids.join(', ')}]`
        : ''),
  );
}

void main();
