// CCP-A11 (PBD §5.1 row A11) — the READ-ONLY production fact-check (see
// src/lib/commercial/ccp-fact-check.ts). One `BEGIN TRANSACTION READ ONLY` session, rolled back;
// counts and states only (no secret, no PII). Usage:
//   npm run ccp:astre-fact-check -- [--database-url <url>] [--po-authorization-ref <ref>]
// A non-local URL is a production read and is refused unless --po-authorization-ref names the
// separate PO authorization (PBD §5.1 row A11 HALT). CCP-A11 runs it against the fixture only.
// Exit codes: 0 report printed; 2 refused / could not run.
import { Client } from 'pg';

import { ccpFactCheck, formatFactCheck, parseFactCheckArgs } from '../src/lib/commercial/ccp-fact-check.js';
import { BackfillRefusedError } from '../src/lib/commercial/pre-ccp-backfill.js';

// Through deploy/jiti-tsconfig-runner.mjs the entry file is argv[2]; directly, argv[1].
function scriptArgs(): string[] {
  const i = process.argv.findIndex((a) => /ccp-astre-fact-check\.(ts|js)$/.test(a));
  return process.argv.slice(i < 0 ? 2 : i + 1);
}

async function main(): Promise<number> {
  const args = parseFactCheckArgs(scriptArgs(), process.env);
  if (args.po_authorization_ref !== null) console.log(`[ccp-fact-check] PO authorization reference: ${args.po_authorization_ref}`);
  const client = new Client({ connectionString: args.database_url });
  await client.connect();
  try {
    for (const line of formatFactCheck(await ccpFactCheck(client))) console.log(line);
    return 0;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof BackfillRefusedError) {
      console.error(`[ccp-fact-check] REFUSED (${err.refusal}): ${err.message}`);
      process.exit(2);
    }
    console.error(`[ccp-fact-check] FATAL: ${(err as Error).message || ((err as { code?: string }).code ?? String(err))}`);
    process.exit(2);
  });
