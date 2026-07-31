// ADR-0024 §D2/§D7 — publish the requisition-lifecycle policy package as DATA.
//
// Runs on a fresh environment via `npm run prisma:seed-policy-lifecycle`, wired
// into deploy/seed-prod.sh (STAGE C, after the Astre identity seed). Idempotent
// per tenant: an already-published version is a no-op, so every deploy can run
// it safely.
//
// PR-4a-2 — publishes the package for BOTH:
//   • the platform SENTINEL tenant ('Aramo Platform', PLATFORM_TENANT_SENTINEL_ID)
//     — this is the TEMPLATE that tenant provisioning copies BYTE-IDENTICAL into
//     every newly-provisioned tenant (apps/platform-admin
//     TenantPolicyProvisioningService reads getActiveVersion(sentinel) and
//     re-publishes the same definition under the new tenant's id).
//   • the Astre seed-time tenant — an operational tenant that must add talent.
// Both receive the identical package DATA, so a provisioned tenant's copy is
// checksum-equal to Astre's and to the template. Seeding the template is a
// PRECONDITION of provisioning: without it, provisioning fails closed loudly
// (POLICY_TEMPLATE_MISSING) rather than creating a package-less tenant.

import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { PolicyStore, PrismaService } from '@aramo/policy-store';

import { REQUISITION_LIFECYCLE_PACKAGE } from './requisition-lifecycle.package.js';

// The system publisher (a stable non-user actor for seed-published policy).
const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';
// The Astre tenant (matches deploy/seed-prod.sh ASTRE_TENANT_ID).
const ASTRE_TENANT_ID =
  process.env['ARAMO_POLICY_SEED_TENANT_ID'] ??
  '019000a0-0000-7000-8000-000000000001';

// The sentinel-hosted TEMPLATE is listed FIRST so it is published before any
// operational tenant; tenant provisioning copies from it.
const SEED_TENANTS: readonly string[] = [
  PLATFORM_TENANT_SENTINEL_ID,
  ASTRE_TENANT_ID,
];

async function publishFor(store: PolicyStore, tenantId: string): Promise<void> {
  const existing = await store.getActiveVersion(
    tenantId,
    REQUISITION_LIFECYCLE_PACKAGE.name,
  );
  if (existing !== null && existing.version === REQUISITION_LIFECYCLE_PACKAGE.version) {
    console.log(
      `[policy-seed] ${REQUISITION_LIFECYCLE_PACKAGE.name}@${existing.version} already published for tenant ${tenantId} — no-op.`,
    );
    return;
  }
  const published = await store.publish({
    tenant_id: tenantId,
    definition: REQUISITION_LIFECYCLE_PACKAGE,
    published_by: SYSTEM_PUBLISHER,
  });
  console.log(
    `[policy-seed] published ${published.package_name}@${published.version} (checksum ${published.checksum.slice(0, 12)}…) for tenant ${tenantId}.`,
  );
}

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
    for (const tenantId of SEED_TENANTS) {
      await publishFor(store, tenantId);
    }
  } finally {
    await prisma.onModuleDestroy(); // closes the connection ($disconnect)
  }
}

main().catch((err) => {
  console.error('[policy-seed] FATAL:', err);
  process.exit(1);
});
