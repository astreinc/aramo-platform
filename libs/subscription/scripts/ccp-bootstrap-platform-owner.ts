// CCP-A9 — the one-time D7 platform-owner bootstrap command (T2-F1-H3 Amendment A1 A1-2).
//
// NOT a seed. It is never invoked by deploy/seed-prod.sh and never imported by seed.ts,
// seed-platform-owner.ts or seed-astre.ts. Running it against production is a production
// write that needs its own PO authorization (A1-2(7)); it must not be run from a context the
// standing engineering laws prohibit.
//
// It grants exactly platform_owner to the single T2-F1-H3 :28 operator and records the
// operator's D9 attestation. It takes no user, email, tenant or role argument. Usage:
//
//   DATABASE_URL=… npm run ccp:bootstrap-platform-owner -- \
//     --po-authorization-ref "<PO authorization reference>" --human-ref-hash <sha256 hex>
//
// Exit codes: 0 granted or already granted (no write); 2 refused; 1 error.
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

import {
  PlatformOwnerBootstrapRefusedError,
  parseBootstrapArgs,
  runPlatformOwnerBootstrap,
} from '../src/lib/commercial/commercial-platform-owner-bootstrap.js';
import { PrismaService } from '../src/lib/prisma/prisma.service.js';

// Through deploy/jiti-tsconfig-runner.mjs (the `npm run` path) the entry file is argv[2];
// directly, argv[1]. The arguments are everything after this file's own entry (D5-DEF-3: a bare
// argv.slice(2) handed the entry path to the parser, which refused it INVALID_ARGUMENT).
function scriptArgs(argv: readonly string[] = process.argv): string[] {
  const i = argv.findIndex((a) => /ccp-bootstrap-platform-owner\.(ts|js)$/.test(a));
  return argv.slice(i < 0 ? 2 : i + 1);
}

async function main(): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    console.error('[ccp-bootstrap] FATAL: DATABASE_URL is not set.');
    return 1;
  }
  const args = parseBootstrapArgs(scriptArgs());
  const prisma = new PrismaService(url);
  await prisma.$connect();
  try {
    const res = await runPlatformOwnerBootstrap(prisma, {
      ...args,
      executed_by: `${userInfo().username}@${hostname()} pid ${process.pid}`,
      correlation_id: `ccp-a9-bootstrap:${randomUUID()}`,
    });
    if (res.outcome === 'NOOP_ALREADY_GRANTED') {
      console.log(`[ccp-bootstrap] no-op: ${res.user_id} already holds platform_owner (nothing written).`);
    } else {
      console.log(`[ccp-bootstrap] granted platform_owner to ${res.user_id}; attestation ${res.attestation_id}; audit event ${res.audit_event_id}.`);
    }
    return 0;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof PlatformOwnerBootstrapRefusedError) {
      console.error(`[ccp-bootstrap] REFUSED: ${err.refusal} ${JSON.stringify(err.detail)}`);
      process.exit(2);
    }
    console.error(`[ccp-bootstrap] FATAL: ${(err as Error).message}`);
    process.exit(1);
  });
