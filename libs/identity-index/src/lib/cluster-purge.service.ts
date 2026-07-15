import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// TR-2b B2a (Directive ruling 4) — purgeCluster, the ONE cluster-teardown
// primitive. Three callers: the daily identity-index lifecycle sweep (orphan
// purge, B2a), the erasure engine (last-reference, B2b), and a future P4 RTBF
// surface. It runs FIVE ordered mutations, RESTRICT-safe and atomic (one tx):
//
//   1. DELETE platform_trust."DormantLink"        WHERE cluster_id = $
//   2. DELETE identity_index."ClusterFingerprint" WHERE cluster_id = $   (child)
//   3. DELETE identity_index."PersonCluster"       WHERE id = $           (parent)
//   4. UPDATE ingestion."RawPayloadReference" SET resolved_cluster_id = NULL …
//   5. UPDATE portal_identity."PortalUser"    SET cluster_id = NULL …
//
// The ClusterFingerprint → PersonCluster FK is ON DELETE RESTRICT, so the child
// delete MUST precede the parent (both inside the tx). Steps 4-5 null UUID-only
// cross-schema pointers (no FK) — the arrival stamp and the portal linkage die
// with the cluster (the PortalUser forward contract registered in Portal P1a).
//
// CONVENTION (Directive §PR-1.2 escape clause, reported in Gate-6): this matches
// the TR-15 B2 erasure engine — CENTRALIZED raw SQL over schema-qualified tables
// via one executor — NOT cross-lib repo delegation. Raw SQL reaches every schema
// on the shared connection, so identity-index (scope:cip) opens NO new nx edge to
// ingestion / portal-identity / platform-trust. A structured line is logged per
// purge (cluster id, per-table ref-count evidence, caller).
export interface PurgeClusterResult {
  cluster_id: string;
  dormant_links_deleted: number;
  fingerprints_deleted: number;
  clusters_deleted: number;
  arrival_stamps_nulled: number;
  portal_users_nulled: number;
}

@Injectable()
export class ClusterPurgeService {
  private readonly logger = new Logger(ClusterPurgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async purgeCluster(
    clusterId: string,
    caller: string,
  ): Promise<PurgeClusterResult> {
    const counts = await this.prisma.$transaction(async (tx) => {
      // 1. Dormant links (UUID-only ref, no FK) — delete first so a purge of a
      //    dormant cluster leaves no orphaned notice-lifecycle row.
      const dormant = await tx.$executeRaw`
        DELETE FROM platform_trust."DormantLink" WHERE cluster_id = ${clusterId}::uuid`;
      // 2. Fingerprints (child of PersonCluster, RESTRICT FK) — before the parent.
      const fingerprints = await tx.$executeRaw`
        DELETE FROM identity_index."ClusterFingerprint" WHERE cluster_id = ${clusterId}::uuid`;
      // 3. The cluster itself (now childless).
      const clusters = await tx.$executeRaw`
        DELETE FROM identity_index."PersonCluster" WHERE id = ${clusterId}::uuid`;
      // 4. Ingestion arrival stamps (UUID-only ref, no FK).
      const arrivals = await tx.$executeRaw`
        UPDATE ingestion."RawPayloadReference"
           SET resolved_cluster_id = NULL
         WHERE resolved_cluster_id = ${clusterId}::uuid`;
      // 5. Portal linkage (UUID-only ref, no FK — the Portal P1a forward contract).
      const portals = await tx.$executeRaw`
        UPDATE portal_identity."PortalUser"
           SET cluster_id = NULL
         WHERE cluster_id = ${clusterId}::uuid`;
      return { dormant, fingerprints, clusters, arrivals, portals };
    });

    const result: PurgeClusterResult = {
      cluster_id: clusterId,
      dormant_links_deleted: counts.dormant,
      fingerprints_deleted: counts.fingerprints,
      clusters_deleted: counts.clusters,
      arrival_stamps_nulled: counts.arrivals,
      portal_users_nulled: counts.portals,
    };
    this.logger.log({ event: 'cluster_purged', caller, ...result });
    return result;
  }
}
