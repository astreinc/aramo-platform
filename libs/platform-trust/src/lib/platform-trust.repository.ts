import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type { DormantLinkStatus } from './dormant-link-status.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for the platform_trust store (TR-2b B2a). The Prisma boundary for
// DormantLink. UUID v7 PKs generated app-side (Postgres 17 has no native
// uuidv7(); the workspace precedent).
//
// In B2a the only WRITE is the flag-gated dormant mint (report-only in
// production, DORMANT_LINK_MINTING_ENABLED=false — exercised only in tests). The
// mint is idempotent per the one-open-link-per-cluster partial-unique index.
// DormantLink DELETION on purge is done by purgeCluster's raw-SQL primitive (the
// erasure-engine convention), NOT through this repo.

export interface DormantLinkRow {
  id: string;
  cluster_id: string;
  detected_at: Date;
  status: DormantLinkStatus;
  notice_version: string | null;
  notice_delivered_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class PlatformTrustRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The open (non-EXPIRED) dormant link for a cluster, if any. */
  async findOpenByCluster(clusterId: string): Promise<DormantLinkRow | null> {
    const row = await this.prisma.dormantLink.findFirst({
      where: { cluster_id: clusterId, status: { not: 'EXPIRED' } },
    });
    return row === null ? null : toRow(row);
  }

  /**
   * Mint a PENDING_NOTICE dormant link for a cluster (the P4-gated dormant
   * detection write). Idempotent: if an open link already exists, returns it and
   * mints nothing (the one-open-link-per-cluster partial unique). Race-safe: a
   * concurrent mint loses on the partial unique and re-reads the winner.
   */
  async mintDormantLink(input: {
    cluster_id: string;
    detected_at: Date;
  }): Promise<DormantLinkRow> {
    const existing = await this.findOpenByCluster(input.cluster_id);
    if (existing !== null) return existing;
    try {
      const row = await this.prisma.dormantLink.create({
        data: {
          id: uuidv7(),
          cluster_id: input.cluster_id,
          detected_at: input.detected_at,
        },
      });
      return toRow(row);
    } catch (err) {
      const after = await this.findOpenByCluster(input.cluster_id);
      if (after === null) throw err;
      return after;
    }
  }

  /** Count all dormant links for a cluster (test/inspection helper). */
  async countByCluster(clusterId: string): Promise<number> {
    return this.prisma.dormantLink.count({ where: { cluster_id: clusterId } });
  }
}

function toRow(row: {
  id: string;
  cluster_id: string;
  detected_at: Date;
  status: string;
  notice_version: string | null;
  notice_delivered_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): DormantLinkRow {
  return {
    id: row.id,
    cluster_id: row.cluster_id,
    detected_at: row.detected_at,
    status: row.status as DormantLinkStatus,
    notice_version: row.notice_version,
    notice_delivered_at: row.notice_delivered_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
