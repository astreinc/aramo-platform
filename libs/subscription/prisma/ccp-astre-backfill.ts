// CCP-A11 (PBD §5.1 row A11) — the Astre backfill, DRY-RUN ONLY (see
// src/lib/commercial/pre-ccp-backfill.ts). Usage:
//   npm run ccp:astre-backfill -- --dry-run [--database-url postgres://…@localhost:…/…]
// (DATABASE_URL is used when --database-url is not given.)
//
// Refused (exit 2, nothing connected): no --dry-run; --execute (CCP-A11 has no execute path;
// executing needs separate PO authorization); a URL that is not localhost / a testcontainer.
// Production is not authorized (PBD §7.5, A0-C15).
// Exit codes: 0 plan computed, no HALT exception; 1 HALT exception(s) or schema not at CCP-A7;
// 2 refused / could not run.
import { Client } from 'pg';

import { BackfillRefusedError, formatBackfillPlan, parseBackfillArgs, planPreCcpBackfill } from '../src/lib/commercial/pre-ccp-backfill.js';

// Through deploy/jiti-tsconfig-runner.mjs the entry file is argv[2]; directly, argv[1].
function scriptArgs(): string[] {
  const i = process.argv.findIndex((a) => /ccp-astre-backfill\.(ts|js)$/.test(a));
  return process.argv.slice(i < 0 ? 2 : i + 1);
}

async function main(): Promise<number> {
  const args = parseBackfillArgs(scriptArgs(), process.env);
  const client = new Client({ connectionString: args.database_url });
  await client.connect();
  try {
    const plan = await planPreCcpBackfill(client);
    for (const line of formatBackfillPlan(plan)) console.log(line);
    return plan.halt ? 1 : 0;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof BackfillRefusedError) {
      console.error(`[ccp-a11] REFUSED (${err.refusal}): ${err.message}`);
      process.exit(2);
    }
    console.error(`[ccp-a11] FATAL: ${(err as Error).message || ((err as { code?: string }).code ?? String(err))}`);
    process.exit(2);
  });
