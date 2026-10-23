import { NestFactory } from '@nestjs/core';
import { createAramoLogger } from '@aramo/common';
import { BackfillRefusedError, IntelligenceBackfillService, type BackfillOptions } from '@aramo/intelligence-integration';

import { IntelligenceBackfillModule } from './intelligence-backfill.module.js';

// ATI-SEP-1 (ADR-0036 "Operations — backfill") — the `intelligence-backfill`
// operator CLI. NO HTTP surface; never runs automatically; no change to the ATS
// create path. Talent Intelligence is a clean rebuild: it starts EMPTY and is
// populated by replaying the COMMITTED ATS data of the tenants holding the
// `intelligence` capability. The run:
//   1. resolves the tenants (all entitled, or --tenant …; a listed tenant
//      without the capability is refused and counted not_entitled);
//   2. runs the full REPLACE entitlement sync;
//   3. keyset-pages LIVE TalentRecords by id and POSTs each record's admission
//      payload (the publisher's builder) with a DETERMINISTIC source_event_id —
//      a re-run over unchanged data is answered replayed:true by TI's inbox.
// Logs carry ids, codes and counts only — never a payload value.
//
// Environment: DATABASE_URL (the ATS database), INTELLIGENCE_SERVICE_URL,
// INTELLIGENCE_ATS_CLIENT_ID, INTELLIGENCE_ATS_CLIENT_SECRET,
// INTELLIGENCE_HTTP_TIMEOUT_MS (per-request timeout, default 5000).
//
// Usage (after build; on the box: `docker compose run --rm api node …`):
//   node dist/apps/api/src/intelligence-backfill/intelligence-backfill.command.js \
//     [--tenant <uuid>]… [--after <talent_id>] [--dry-run] [--limit N] \
//     [--concurrency N (default 4)] [--page-size N (default 200)] [--max-attempts N (default 5)]
//
//   --dry-run   build + validate every payload; no TI call, no link write
//               (TI need not be configured).
//   --after     resume after this talent record id (exactly one --tenant); the
//               cursor is the `after` of the last intelligence_backfill_checkpoint line.
//
// Exit codes: 0 = every scanned record ingested / replayed (or validated, dry-run)
// and every listed tenant entitled; 3 = finished with rejected / failed /
// not_entitled > 0 (re-run is safe); 2 = usage / refused; 1 = crash.
// The summary is printed to stdout as JSON.

interface ParsedArgs {
  opts: BackfillOptions;
  error?: string;
}

function positiveInt(v: string | undefined): number | null {
  if (v === undefined || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

export function parseBackfillArgs(argv: readonly string[]): ParsedArgs {
  const tenants: string[] = [];
  const opts: BackfillOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = (key: 'limit' | 'concurrency' | 'pageSize' | 'maxAttempts'): string | undefined => {
      const n = positiveInt(argv[++i]);
      if (n === null) return `${a} needs a positive integer`;
      opts[key] = n;
      return undefined;
    };
    let err: string | undefined;
    switch (a) {
      case '--tenant': {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) err = '--tenant needs a tenant id';
        else tenants.push(...v.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
        break;
      }
      case '--after': {
        const v = argv[++i];
        if (v === undefined || v.startsWith('--')) err = '--after needs a talent record id';
        else opts.after = v.trim();
        break;
      }
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--limit':
        err = num('limit');
        break;
      case '--concurrency':
        err = num('concurrency');
        break;
      case '--page-size':
        err = num('pageSize');
        break;
      case '--max-attempts':
        err = num('maxAttempts');
        break;
      default:
        err = `unknown argument: ${a}`;
    }
    if (err !== undefined) return { opts, error: err };
  }
  if (tenants.length > 0) opts.tenants = tenants;
  return { opts };
}

const USAGE =
  'usage: intelligence-backfill [--tenant <uuid>]… [--after <talent_id>] [--dry-run] [--limit N] [--concurrency N] [--page-size N] [--max-attempts N]';

async function main(): Promise<void> {
  const logger = createAramoLogger('IntelligenceBackfill');
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    logger.error({ event: 'intelligence_backfill_usage', message: `${parsed.error} — ${USAGE}` });
    process.exit(2);
  }

  // Never host the background loops / outbox drain in this process.
  process.env['ATS_TALENT_EVENTS_DRAIN_ENABLED'] = '0';
  const app = await NestFactory.createApplicationContext(IntelligenceBackfillModule, { bufferLogs: false });
  try {
    const summary = await app.get(IntelligenceBackfillService, { strict: false }).run(parsed.opts);
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    await app.close();
    process.exit(summary.rejected + summary.failed + summary.not_entitled > 0 ? 3 : 0);
  } catch (err) {
    const refused = err instanceof BackfillRefusedError;
    logger.error({
      event: refused ? 'intelligence_backfill_refused' : 'intelligence_backfill_crashed',
      code: refused ? err.code : 'UNEXPECTED',
      reason: err instanceof Error ? err.message : 'unknown',
    });
    await app.close().catch(() => undefined);
    process.exit(refused ? 2 : 1);
  }
}

// Run only as the entrypoint (the arg parser is importable by tests).
if (process.argv[1] !== undefined && /intelligence-backfill\.command\.(js|ts)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error('intelligence-backfill failed', err);
    process.exit(1);
  });
}
