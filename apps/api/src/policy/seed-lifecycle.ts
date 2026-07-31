// ADR-0024 §D2/§D7 — publish the requisition-lifecycle policy package as DATA.
//
// Runs on a fresh environment via `npm run prisma:seed-policy-lifecycle`, wired
// into deploy/seed-prod.sh (STAGE C, after the Astre identity seed). Idempotent:
// if the tenant already has this version published it is a no-op, so every
// deploy can run it safely.
//
// ⛔ RESIDUAL GAP — BLOCKING, tracked in doc/go-live-known-limitations.md:
// this seeds the package for the SEED-TIME tenant(s) only (Astre by default).
// A tenant PROVISIONED AFTER seed time has NO package, and PR-4a FAILS CLOSED
// on no package — so EVERY add-talent command for that tenant DENYs (403
// NO_POLICY_PUBLISHED) from creation. Publishing the default package at
// tenant-provisioning time is PR-4a-2. UNTIL PR-4a-2 LANDS, NO NEW TENANT MAY
// BE PROVISIONED (a second tenant would have a non-functional add-talent path).

import { PolicyStore, PrismaService } from '@aramo/policy-store';

import { REQUISITION_LIFECYCLE_PACKAGE } from './requisition-lifecycle.package.js';

// The system publisher (a stable non-user actor for seed-published policy).
const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';
// Default: the Astre tenant (matches deploy/seed-prod.sh ASTRE_TENANT_ID).
const TENANT_ID = process.env['ARAMO_POLICY_SEED_TENANT_ID'] ?? '019000a0-0000-7000-8000-000000000001';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    console.error('[policy-seed] FATAL: DATABASE_URL is not set.');
    process.exit(1);
  }
  const prisma = new PrismaService(url);
  await prisma.$connect();
  const store = new PolicyStore(prisma);
  try {
    const existing = await store.getActiveVersion(TENANT_ID, REQUISITION_LIFECYCLE_PACKAGE.name);
    if (existing !== null && existing.version === REQUISITION_LIFECYCLE_PACKAGE.version) {
      console.log(
        `[policy-seed] ${REQUISITION_LIFECYCLE_PACKAGE.name}@${existing.version} already published for tenant ${TENANT_ID} — no-op.`,
      );
      return;
    }
    const published = await store.publish({
      tenant_id: TENANT_ID,
      definition: REQUISITION_LIFECYCLE_PACKAGE,
      published_by: SYSTEM_PUBLISHER,
    });
    console.log(
      `[policy-seed] published ${published.package_name}@${published.version} (checksum ${published.checksum.slice(0, 12)}…) for tenant ${TENANT_ID}.`,
    );
  } finally {
    await prisma.onModuleDestroy(); // closes the connection ($disconnect)
  }
}

main().catch((err) => {
  console.error('[policy-seed] FATAL:', err);
  process.exit(1);
});
