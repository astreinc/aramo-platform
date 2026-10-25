// CCP-D1 (PBD §5.4 row D1) — the one-shot usage roll-up command (operator evidence and recovery).
// Runs ONE roll-up (the same UsageRollupService.run the platform-admin worker schedules), then
// prints the live reconciliation as JSON. It never writes the AllowanceUsage ledger: only the
// derived roll-up tables. Exit 0 = RECONCILED, 1 = NOT_RECONCILED / NOT_RUN / BUSY / CONFLICT.
// Usage:
//   DATABASE_URL=… npm run usage:rollup                       incremental (FULL on the first run)
//   DATABASE_URL=… npm run usage:rollup -- --rebuild          recompute every derived row
//   DATABASE_URL=… npm run usage:rollup -- --reconcile-only   read-only: no run, status only
// Executing it against production needs its own authorization (PBD §7.5, §12).
import { PrismaService } from '../src/lib/prisma/prisma.service.js';
import { UsageRollupService } from '../src/lib/usage/usage-rollup.service.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('[usage-rollup] FATAL: set DATABASE_URL.');
    process.exit(2);
  }
  const reconcileOnly = process.argv.includes('--reconcile-only');
  const rebuild = process.argv.includes('--rebuild');
  if (reconcileOnly && rebuild) {
    console.error('[usage-rollup] FATAL: --reconcile-only and --rebuild are exclusive.');
    process.exit(2);
  }
  const prisma = new PrismaService(url);
  await prisma.$connect();
  try {
    const service = new UsageRollupService(prisma);
    if (!reconcileOnly) {
      const run = await service.run({ rebuild });
      console.log(`[usage-rollup] run ${run.status}: ${JSON.stringify(run.metrics)}`);
      if (run.status !== 'COMPLETED') {
        process.exitCode = 1;
        return;
      }
    }
    const rec = await service.reconcile('sign');
    console.log(JSON.stringify(rec, null, 2));
    console.log(`[usage-rollup] ${rec.status}`);
    process.exitCode = rec.status === 'RECONCILED' ? 0 : 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error(`[usage-rollup] FATAL: ${(err as Error).message}`);
  process.exit(2);
});
