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
