// CCP-A6 (Conversion Rule C-16, C-17) — the READ-ONLY pre-cutover check (see
// src/lib/billing/checkout-cutover-check.ts). It writes nothing: one `BEGIN TRANSACTION READ
// ONLY` session, rolled back. Exit 0 = no conflicting open checkout intent; 1 = C-17 HALT (each
// listed intent needs a PO-recorded disposition); 2 = could not run. Usage:
//   DATABASE_URL=… npm run billing:cutover-check
// Running it against production needs its own PO authorization (PBD §7.5); it is not run there
// by CCP-A6.
import { Client } from 'pg';

import { checkoutCutoverReport, formatCheckoutCutoverReport } from '../src/lib/billing/checkout-cutover-check.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('[cutover-check] FATAL: set DATABASE_URL.');
    process.exit(2);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const report = await checkoutCutoverReport(client);
    for (const line of formatCheckoutCutoverReport(report)) console.log(line);
    process.exitCode = report.halt ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`[cutover-check] FATAL: ${(err as Error).message}`);
  process.exit(2);
});
