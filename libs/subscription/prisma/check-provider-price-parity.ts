// CCP-A5 (MP-A2 N-17; Charter D3 "env-parity check during cutover") — the READ-ONLY parity
// check between STRIPE_PLAN_PRICES and the provider prices pinned to plan versions. It writes
// nothing (READ ONLY transaction) and prints one line per entry. Exit 0 = parity holds, 1 = a
// failure (MISMATCH, UNKNOWN_PLAN, NO_PUBLISHED_VERSION, DUPLICATE_PRICE; with --strict also
// ENV_FALLBACK, i.e. an env price not yet pinned to its version). Usage:
//   DATABASE_URL=… STRIPE_PLAN_PRICES=… npm run billing:price-parity [-- --strict]
import { checkProviderPriceParity } from '../src/lib/billing/provider-price.js';
import { PrismaService } from '../src/lib/prisma/prisma.service.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('[price-parity] FATAL: set DATABASE_URL.');
    process.exit(2);
  }
  const strict = process.argv.includes('--strict');
  const prisma = new PrismaService(url);
  await prisma.$connect();
  try {
    const report = await checkProviderPriceParity(prisma, process.env['STRIPE_PLAN_PRICES'], { strict });
    for (const e of report.entries) {
      console.log(
        `[price-parity] ${e.status.padEnd(20)} ${e.plan_key} env=${e.env_price_ref ?? '-'} pinned=${e.pinned_price_ref ?? '-'} version=${e.version_number ?? '-'}${e.detail ? ` (${e.detail})` : ''}`,
      );
    }
    console.log(`[price-parity] ${report.ok ? 'OK' : 'FAILED'}: ${report.entries.length} entries, ${report.failures} failures (${strict ? 'strict' : 'cutover'} mode).`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error(`[price-parity] FATAL: ${(err as Error).message}`);
  process.exit(2);
});
