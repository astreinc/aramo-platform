import { PolicyStore, PrismaService } from '@aramo/policy-store';

import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

// Shared test seed — publish the requisition-lifecycle package for a tenant, so
// the retrieval-based policy service (PR-4a) resolves it instead of failing
// closed. ONE helper, not N duplicated publishes across the specs that exercise
// an ALLOW add (the same collapse as the migration-list sweep). Goes through
// PolicyStore.publish → validatePackage + a real checksum, so it exercises the
// same stored representation the app retrieves.

const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';

export async function publishLifecyclePackage(url: string, tenantId: string): Promise<void> {
  const prisma = new PrismaService(url);
  await prisma.$connect();
  const store = new PolicyStore(prisma);
  try {
    await store.publish({
      tenant_id: tenantId,
      definition: REQUISITION_LIFECYCLE_PACKAGE,
      published_by: SYSTEM_PUBLISHER,
    });
  } finally {
    await prisma.onModuleDestroy();
  }
}
