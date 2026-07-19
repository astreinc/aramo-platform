import { PrismaPg } from '@prisma/adapter-pg';

import { seedHostAuthProfiles } from '../src/lib/host-auth-profile.seed.js';

import { PrismaClient } from './generated/client/client.js';

// Auth-Decoupling PR-1 §2.4 — runnable seed for the host auth-profile registry.
// `npm run prisma:seed-auth-storage` invokes this file. Idempotent: upserts the
// three class rows (TENANT | PLATFORM | PORTAL) from the current env, reproducing
// today's behaviour exactly. Safe to run on every deploy.
//
// NOT wired into deploy/seed-prod.sh in PR-1: the registry is behaviour-safe
// EMPTY (a miss falls through to the retained env chain, R-A1-3), so activating
// it in prod is an ops step, not a code dependency. This entry makes that step a
// one-liner when the platform pool split (ADR-0021) is scheduled.
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is not configured');
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    await prisma.$connect();
    const { seeded } = await seedHostAuthProfiles(prisma);
    console.log(`host-auth-profile seed: upserted ${seeded.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /seed\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('host-auth-profile seed failed:', err);
    process.exit(1);
  });
}
