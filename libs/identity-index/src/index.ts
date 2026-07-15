// Public surface of @aramo/identity-index (Step 4a). The cross-tenant PII-free
// resolution index (PERSON_CLUSTER) substrate.
//
// The tenant-side email fingerprint primitive lives in @aramo/common
// (computeEmailFingerprint) — NOT here — so the raw email is fingerprinted
// before it ever crosses into this schema. This lib only stores/reads the
// opaque result.

export { IdentityIndexModule } from './lib/identity-index.module.js';
export { IdentityIndexRepository } from './lib/identity-index.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
// TR-2b B2a/B2b — the cluster-teardown primitive (purgeCluster): the DI Prisma
// binding (sweep), the raw-PgExec binding (erasure engine), and the ONE shared
// ordered statement array both consume.
export {
  ClusterPurgeService,
  purgeClusterViaExec,
  CLUSTER_PURGE_STATEMENTS,
  type ClusterPurgeExec,
  type PurgeClusterResult,
} from './lib/cluster-purge.service.js';

export type {
  PersonClusterRow,
  ClusterFingerprintRow,
} from './lib/identity-index.repository.js';
