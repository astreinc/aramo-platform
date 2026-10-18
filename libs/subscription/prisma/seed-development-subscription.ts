// Governed development/test path (Multi-Provider directive §B): opens a
// DEVELOPMENT subscription on the Aramo Sign included plan for ONE explicitly
// named tenant. Refuses production (NODE_ENV/ARAMO_ENV); never run by the prod
// deploy. Usage:
//   ARAMO_ENV=local ARAMO_SUBSCRIPTION_TENANT_ID=<uuid> npm run prisma:seed-dev-subscription
import { openDevelopmentSubscription } from '../src/lib/development-subscription.js';
import { PrismaService } from '../src/lib/prisma/prisma.service.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  const tenant = process.env['ARAMO_SUBSCRIPTION_TENANT_ID'];
  if (!url || !tenant || !/^[0-9a-f-]{36}$/i.test(tenant)) {
    console.error('[subscription-seed] FATAL: set DATABASE_URL and ARAMO_SUBSCRIPTION_TENANT_ID (uuid).');
    process.exit(1);
  }
  const prisma = new PrismaService(url);
  await prisma.$connect();
  try {
    const res = await openDevelopmentSubscription(prisma, { tenant_id: tenant, created_by: 'seed-development-subscription' });
    console.log(`[subscription-seed] tenant ${tenant}: ${res.created ? 'opened' : 'already has'} subscription ${res.subscription_id}.`);
  } finally {
    await prisma.onModuleDestroy();
  }
}

main().catch((err: unknown) => {
  console.error(`[subscription-seed] FATAL: ${(err as Error).message}`);
  process.exit(1);
});
