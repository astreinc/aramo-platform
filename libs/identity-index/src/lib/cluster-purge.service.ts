import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// TR-2b B2a/B2b (Directive ruling 4) — purgeCluster, the ONE cluster-teardown
// primitive. Three callers: the daily identity-index lifecycle sweep (orphan
// purge, B2a), the erasure engine (last-reference, B2b), and a future P4 RTBF
// surface. It runs SIX ordered mutations, RESTRICT-safe:
//
//   1. DELETE platform_trust."DormantLink"        WHERE cluster_id = $1
//   2. DELETE talent_trust."PortalDispute"         WHERE cluster_id = $1   (cascades)
//   3. DELETE identity_index."ClusterFingerprint" WHERE cluster_id = $1   (child)
//   4. DELETE identity_index."PersonCluster"       WHERE id = $1           (parent)
//   5. UPDATE ingestion."RawPayloadReference" SET resolved_cluster_id = NULL …
//   6. UPDATE portal_identity."PortalUser"    SET cluster_id = NULL …
//
// The ClusterFingerprint → PersonCluster FK is ON DELETE RESTRICT, so the child
// delete MUST precede the parent. Step 2 (Portal P3a) is a cluster-keyed cross-
// schema delete with NO FK to PersonCluster — the daily orphan-purge (B2a) can
// tear a cluster down independently of the talent_trust erasure flow, so a
// dispute keyed to it must die here or its cluster_id would dangle; its
// WorkItem + Statement children CASCADE. GENERAL RULE: a cluster-keyed table
// registers in CLUSTER_PURGE_STATEMENTS at birth (the third keyspace class,
// beside subject-keyed erasure-inventory and record-keyed reconcile-repoint).
// Steps 5-6 null UUID-only cross-schema pointers (no FK) — the arrival stamp and
// the portal linkage die with the cluster (the PortalUser forward contract
// registered in Portal P1a).
//
// TR-2b B2b (Directive §PR-2.1) — the SQL now lives in ONE exported ordered array
// (CLUSTER_PURGE_STATEMENTS) consumed by BOTH the Prisma `$transaction` path
// (ClusterPurgeService, the sweep) AND the raw PgExec path (purgeClusterViaExec,
// the erasure engine) — one primitive, two executor bindings, pinned identical by
// the cluster-purge tripwire spec.
//
// CONVENTION (reported in Gate-6): centralized raw SQL over schema-qualified
// tables, NOT cross-lib repo delegation — so identity-index (scope:cip) opens NO
// new nx edge to ingestion / portal-identity / platform-trust.

// The result field each statement's affected-row count maps to (order = exec order).
export const CLUSTER_PURGE_STATEMENTS = [
  {
    key: 'dormant_links_deleted',
    sql: `DELETE FROM platform_trust."DormantLink" WHERE cluster_id = $1::uuid`,
  },
  {
    // Portal P3a — cluster-keyed dispute rows; WorkItem + Statement cascade.
    key: 'portal_disputes_deleted',
    sql: `DELETE FROM talent_trust."PortalDispute" WHERE cluster_id = $1::uuid`,
  },
  {
    key: 'fingerprints_deleted',
    sql: `DELETE FROM identity_index."ClusterFingerprint" WHERE cluster_id = $1::uuid`,
  },
  {
    key: 'clusters_deleted',
    sql: `DELETE FROM identity_index."PersonCluster" WHERE id = $1::uuid`,
  },
  {
    key: 'arrival_stamps_nulled',
    sql: `UPDATE ingestion."RawPayloadReference" SET resolved_cluster_id = NULL WHERE resolved_cluster_id = $1::uuid`,
  },
  {
    key: 'portal_users_nulled',
    sql: `UPDATE portal_identity."PortalUser" SET cluster_id = NULL WHERE cluster_id = $1::uuid`,
  },
] as const;

export interface PurgeClusterResult {
  cluster_id: string;
  dormant_links_deleted: number;
  portal_disputes_deleted: number;
  fingerprints_deleted: number;
  clusters_deleted: number;
  arrival_stamps_nulled: number;
  portal_users_nulled: number;
}

// The minimal executor abstraction both bindings satisfy: run one parameterized
// statement, return the affected row count. (Prisma adapter wraps
// $executeRawUnsafe; PgExec adapter wraps pg.query().rowCount.)
export interface ClusterPurgeExec {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

type PurgeLog = (entry: Record<string, unknown>) => void;

// The shared core: run CLUSTER_PURGE_STATEMENTS in order over the given executor.
async function runPurgeStatements(
  exec: ClusterPurgeExec,
  clusterId: string,
): Promise<PurgeClusterResult> {
  const counts: Record<string, number> = {};
  for (const stmt of CLUSTER_PURGE_STATEMENTS) {
    const res = await exec.query(stmt.sql, [clusterId]);
    counts[stmt.key] = res.rowCount ?? 0;
  }
  return {
    cluster_id: clusterId,
    dormant_links_deleted: counts['dormant_links_deleted'] ?? 0,
    portal_disputes_deleted: counts['portal_disputes_deleted'] ?? 0,
    fingerprints_deleted: counts['fingerprints_deleted'] ?? 0,
    clusters_deleted: counts['clusters_deleted'] ?? 0,
    arrival_stamps_nulled: counts['arrival_stamps_nulled'] ?? 0,
    portal_users_nulled: counts['portal_users_nulled'] ?? 0,
  };
}

/**
 * The raw-PgExec binding of purgeCluster (TR-2b B2b) — for the erasure engine,
 * which is PgExec-only (no DI, no Prisma). Runs the SAME ordered statement array
 * over the caller's executor (the erase pass's pg.Client). The caller owns the
 * transaction boundary (the erasure engine's per-step convention); the ordered
 * child-before-parent deletes are RESTRICT-safe run sequentially. `log` emits the
 * structured per-purge line if supplied.
 */
export async function purgeClusterViaExec(
  exec: ClusterPurgeExec,
  clusterId: string,
  caller: string,
  log?: PurgeLog,
): Promise<PurgeClusterResult> {
  const result = await runPurgeStatements(exec, clusterId);
  log?.({ event: 'cluster_purged', caller, ...result });
  return result;
}

@Injectable()
export class ClusterPurgeService {
  private readonly logger = new Logger(ClusterPurgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async purgeCluster(
    clusterId: string,
    caller: string,
  ): Promise<PurgeClusterResult> {
    // The Prisma binding: one $transaction (atomic), the same statement array via
    // $executeRawUnsafe adapted to the shared executor shape.
    const result = await this.prisma.$transaction(async (tx) => {
      const exec: ClusterPurgeExec = {
        query: async (sql, params) => ({
          rowCount: await tx.$executeRawUnsafe(sql, ...params),
        }),
      };
      return runPurgeStatements(exec, clusterId);
    });
    this.logger.log({ event: 'cluster_purged', caller, ...result });
    return result;
  }
}
