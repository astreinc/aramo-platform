import { Logger } from '@nestjs/common';
import { Client } from 'pg';

import { TalentDataInventoryService } from '../talent-identity/talent-data-inventory.service.js';
import type { PgExec } from '../talent-identity/talent-erasure.service.js';

// TR-15 B2 (DDR §6 — D5) — the `talent-data-inventory` admin CLI. NO HTTP
// surface. Prints, as JSON to stdout, the read-only per-talent data inventory
// (the DSAR raw material): scope, per-holder counts, consent ledger, trust
// bands, evidence timeline, document/attachment refs. Read-only — every query
// is a SELECT; no row is written.
//
// Usage (after build):
//   node dist/apps/api/src/talent-anchor/talent-data-inventory.command.js <tenant_id> <record_id>
async function main(): Promise<void> {
  const logger = new Logger('TalentDataInventory');
  const tenantId = process.argv[2];
  const recordId = process.argv[3];

  if (
    tenantId === undefined ||
    recordId === undefined ||
    tenantId.trim().length === 0 ||
    recordId.trim().length === 0
  ) {
    logger.error('usage: talent-data-inventory <tenant_id> <record_id>');
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

  try {
    const inventory = await new TalentDataInventoryService().assemble(pg, tenantId, recordId);
    // JSON to stdout (the deliverable); a one-line summary to the logger.
    process.stdout.write(JSON.stringify(inventory, null, 2) + '\n');
    logger.log(
      `talent-data-inventory: ${inventory.scope.record_ids.length} record(s), ` +
        `${inventory.scope.subject_ids.length} subject(s), ${inventory.total_rows} data row(s), ` +
        `is_anonymized=${inventory.is_anonymized} (read-only — no writes)`,
    );
  } finally {
    await client.end();
  }
}

void main();
