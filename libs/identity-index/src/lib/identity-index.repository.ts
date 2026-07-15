import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the identity_index resolution store (Step 4a). The Prisma
// boundary for the PII-free cross-tenant index. UUID v7 PKs are generated
// app-side (Postgres 17 has no native uuidv7(); identity/submittal/
// canonicalization/talent-trust precedent).
//
// SCOPE (4a): the find/create primitives ONLY. No resolver wiring into the
// canonicalization path — that is step 4b. Callers pass an already-computed
// opaque fingerprint (see @aramo/common computeEmailFingerprint); the raw
// email never reaches this layer.

export interface PersonClusterRow {
  id: string;
  created_at: Date;
  updated_at: Date;
}

export interface ClusterFingerprintRow {
  id: string;
  cluster_id: string;
  fingerprint: string;
  kind: string;
  created_at: Date;
}

@Injectable()
export class IdentityIndexRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a cluster by its opaque fingerprint. Returns the owning
   * PersonCluster row, or null if the fingerprint is unknown (a new identity).
   */
  async findClusterByFingerprint(
    fingerprint: string,
  ): Promise<PersonClusterRow | null> {
    const fp = await this.prisma.clusterFingerprint.findUnique({
      where: { fingerprint },
      include: { cluster: true },
    });
    if (fp === null) return null;
    return {
      id: fp.cluster.id,
      created_at: fp.cluster.created_at,
      updated_at: fp.cluster.updated_at,
    };
  }

  /**
   * Existence/identity lookup by cluster id. Returns the PersonCluster row or
   * null. Used by the cluster-exists validation when a caller links a record to
   * a known PERSON_CLUSTER (step 4d) — no PII, no fingerprint needed.
   */
  async findClusterById(id: string): Promise<PersonClusterRow | null> {
    const cluster = await this.prisma.personCluster.findUnique({
      where: { id },
    });
    if (cluster === null) return null;
    return {
      id: cluster.id,
      created_at: cluster.created_at,
      updated_at: cluster.updated_at,
    };
  }

  /**
   * Resolve a cluster by fingerprint, creating it if absent. Race-safe: if a
   * concurrent caller wins the create (the @@unique([fingerprint]) rejects the
   * loser), the loser re-reads and returns the winner's cluster. This is the
   * resolve-or-create primitive the cross-tenant resolver (step 4b) calls — the
   * unique index is the serialization point, so two tenants ingesting the same
   * email concurrently converge on ONE cluster.
   */
  async findOrCreateClusterByFingerprint(
    fingerprint: string,
    kind: string,
  ): Promise<PersonClusterRow> {
    const existing = await this.findClusterByFingerprint(fingerprint);
    if (existing !== null) return existing;
    try {
      return await this.createClusterWithFingerprint(fingerprint, kind);
    } catch (err) {
      // Lost the create race (unique-violation on fingerprint) → the winner's
      // cluster now exists; re-read it. Any other error propagates.
      const afterRace = await this.findClusterByFingerprint(fingerprint);
      if (afterRace !== null) return afterRace;
      throw err;
    }
  }

  /**
   * TR-2b B2a — keyset-paginated cluster enumeration for the daily lifecycle
   * sweep. Ordered by `id` (uuidv7 → roughly creation order), `id > afterId` for
   * the cursor, `LIMIT batchSize`. The sweep applies the R4 liveness rule + the
   * ORPHAN_GRACE age gate per row (both need cross-schema reads identity-index
   * does not own), so this is a plain bounded page — no liveness/age filter here.
   */
  async listClustersForSweep(input: {
    batchSize: number;
    afterId?: string;
  }): Promise<PersonClusterRow[]> {
    const rows = await this.prisma.personCluster.findMany({
      where: input.afterId === undefined ? {} : { id: { gt: input.afterId } },
      orderBy: { id: 'asc' },
      take: input.batchSize,
    });
    return rows.map((c) => ({
      id: c.id,
      created_at: c.created_at,
      updated_at: c.updated_at,
    }));
  }

  /**
   * Mint a new PersonCluster and attach the given fingerprint to it, atomically.
   * Returns the new cluster. Caller is responsible for having checked
   * findClusterByFingerprint first (the @@unique([fingerprint]) is the
   * structural backstop against a race).
   */
  async createClusterWithFingerprint(
    fingerprint: string,
    kind: string,
  ): Promise<PersonClusterRow> {
    const clusterId = uuidv7();
    const fingerprintId = uuidv7();
    return this.prisma.$transaction(async (tx) => {
      const cluster = await tx.personCluster.create({
        data: { id: clusterId },
      });
      await tx.clusterFingerprint.create({
        data: {
          id: fingerprintId,
          cluster_id: clusterId,
          fingerprint,
          kind,
        },
      });
      return {
        id: cluster.id,
        created_at: cluster.created_at,
        updated_at: cluster.updated_at,
      };
    });
  }
}
