import { Logger } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { ObjectStorageService, S3ClientFactory } from '@aramo/object-storage';
import { Client } from 'pg';

import {
  ERASURE_EXIT_CODES,
  TalentErasureService,
  type ErasureObjectStore,
  type ErasureOutcome,
  type ErasureReport,
  type PgExec,
} from '../talent-identity/talent-erasure.service.js';

// TR-15 B2 (DDR §5) — the `erase-talent` admin CLI. NO HTTP surface. Automates
// doc/runbooks/talent-rtbf-erasure.md: resolve the whole human (husk chain +
// trust cluster), delete every PII holder child-before-parent, purge every
// object-storage artifact (every version + delete-marker), append the retained
// consent erasure marker, and flip is_anonymized.
//
// S2 Talent Erasure Integrity (Architect rulings F1/F5): the CLI reports ONLY
// what is true. A completed erasure is the single success (exit 0). Every other
// outcome exits non-zero with its own code so automation can never read it as
// done:
//   0 COMPLETED        — database pass committed AND every artifact purged
//   2 BLOCKED          — preflight found holders this erasure may not remove;
//                        NOTHING was deleted
//   3 STORAGE_PENDING  — the database pass committed, some artifacts are not
//                        yet verifiably purged; re-run with --resume
//   4 FAILED           — the database pass rolled back (nothing deleted), or no
//                        record / run exists
//   1 usage / configuration / confirmation error
//
// DRY-RUN IS THE DEFAULT (the per-table would-delete inventory, the preflight
// blockers and the artifacts; ZERO writes). The live run requires BOTH
// `--execute` AND typing the record id again as a confirmation string. Re-running
// --execute (or --resume) over a recorded run is idempotent.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/erase-talent.command.js <tenant_id> <record_id>
//   node dist/apps/api/src/talent-anchor/erase-talent.command.js <tenant_id> <record_id> --execute <record_id>
//   node dist/apps/api/src/talent-anchor/erase-talent.command.js <tenant_id> <record_id> --resume <record_id>
async function main(): Promise<void> {
  const logger = new Logger('EraseTalent');
  const tenantId = process.argv[2];
  const recordId = process.argv[3];
  const flag = process.argv[4];
  const confirm = process.argv[5];

  if (tenantId === undefined || recordId === undefined || tenantId.trim().length === 0 || recordId.trim().length === 0) {
    logger.error('usage: erase-talent <tenant_id> <record_id> [--execute|--resume <record_id-as-confirmation>]');
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
  // ONE connection for the whole run — the database pass is BEGIN … COMMIT on it.
  const pg: PgExec = {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await client.query(sql, params as unknown[] | undefined);
      return { rows: r.rows as T[], rowCount: r.rowCount };
    },
  };
  const svc = new TalentErasureService();

  try {
    if (flag === '--execute' || flag === '--resume') {
      if (confirm !== recordId) {
        logger.error(`confirmation mismatch: to ${flag}, re-type the record id as the final argument`);
        process.exitCode = 1;
        return;
      }
      // S2 F5 — the real, version-aware purge through the existing storage
      // abstraction (S3_RESUME_BUCKET, the one versioned platform bucket). A
      // missing IAM permission surfaces as a FAILED artifact → STORAGE_PENDING,
      // never as success.
      const storage = new ObjectStorageService(new S3ClientFactory(), createAramoLogger('EraseTalentStorage'));
      const store: ErasureObjectStore = {
        purge: async (key) => {
          const r = await storage.purgeObjectAllVersions({ storage_key: key, requestId: `erase-talent-${recordId}` });
          return { remaining: r.remaining };
        },
      };
      const report =
        flag === '--execute'
          ? await svc.execute(pg, tenantId, recordId, store)
          : await svc.resume(pg, tenantId, recordId, store);
      printReport(logger, report);
      const code = ERASURE_EXIT_CODES[report.outcome as Exclude<ErasureOutcome, 'DRY_RUN'>] ?? 4;
      const line =
        `erase-talent ${report.outcome}: ${report.total_rows} row(s) deleted; ` +
        `artifacts purged ${report.storage.purged}/${report.storage.total}; ` +
        `marker_appended=${report.erasure_marker_appended}; is_anonymized=${report.is_anonymized_flipped}` +
        (report.failure !== undefined ? ` — ${report.failure}` : '');
      if (code === 0) logger.log(line);
      else logger.error(line);
      process.exitCode = code;
    } else {
      const report = await svc.dryRun(pg, tenantId, recordId);
      printReport(logger, report);
      logger.log(
        `erase-talent DRY-RUN — ${report.total_rows} row(s) WOULD delete; ${report.storage.total} artifact(s) WOULD be purged; ` +
          (report.blockers.length > 0
            ? `${report.blockers.length} BLOCKER(S): an --execute would be refused; ZERO writes.`
            : `no blockers; ZERO writes. Re-run with '--execute ${recordId}' to erase.`),
      );
    }
  } catch (err) {
    logger.error(`erase-talent FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 4;
  } finally {
    await client.end();
  }
}

function printReport(logger: Logger, report: ErasureReport): void {
  logger.log(`erase-talent [${report.mode}] tenant=${report.tenant_id} record=${report.record_id} outcome=${report.outcome}`);
  logger.log(
    `  scope: ${report.scope.record_ids.length} record(s) (husk chain), ` +
      `${report.scope.subject_ids.length} trust subject(s), ${report.storage.total} object-storage artifact(s)`,
  );
  for (const b of report.blockers) {
    logger.warn(`  BLOCKER [${b.classification}] ${b.holder}: ${b.count} row(s) — ${b.reason} (needs: ${b.authority})`);
  }
  for (const s of report.steps) {
    const verb = report.mode === 'dry-run' ? 'would-delete' : s.status;
    logger.log(`  ${s.table}: ${s.count} ${verb}${s.error ? ` [error: ${s.error}]` : ''}`);
  }
  const st = report.storage;
  logger.log(`  storage: ${st.purged} purged, ${st.pending} pending, ${st.failed} failed (of ${st.total})`);
  logger.log(`  RETAINED (audit, not deleted): ${report.retained.join(', ')}`);
  const cp = report.cluster_purge;
  const clusterVerb = report.mode === 'dry-run' ? 'would-purge' : 'purged';
  logger.log(
    `  clusters: ${cp.captured_cluster_ids.length} referenced, ${cp.orphaned_cluster_ids.length} orphaned → ${clusterVerb}` +
      (cp.orphaned_cluster_ids.length > 0 ? ` [${cp.orphaned_cluster_ids.join(', ')}]` : ''),
  );
}

void main();
