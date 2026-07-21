import { Injectable } from '@nestjs/common';

import type { SyncStatus } from './channel-posting.types.js';
import { PrismaService } from './prisma/prisma.service.js';

// SRC-2 PR-3 — the posting-state repository: the R4 sweep's persistent memory of
// what is live on each channel (ChannelPostingState) and which tenant×channel is
// opted in (TenantChannelConfig). Lib-local PrismaService (this lib's own
// generated client) — no @aramo edge.
//
// Two-phase writes give crash-safe re-entry: the sweep marks PENDING_CREATE /
// PENDING_UPDATE / PENDING_EXPIRE with the target content hash BEFORE the connector
// call, then LIVE / EXPIRED after. A process death mid-tick leaves a PENDING_* row
// that the next tick re-drives (upsert idempotency makes the retry safe). A
// connector failure lands ERROR (re-enterable — the next tick re-plans it).

export interface ChannelPostingStateRow {
  id: string;
  tenant_id: string;
  requisition_id: string;
  channel: string;
  external_posting_id: string | null;
  content_hash: string;
  last_synced_at: Date | null;
  sync_status: SyncStatus;
  tombstoned_at: Date | null;
}

export interface TenantChannelConfigRow {
  tenant_id: string;
  channel: string;
  config: unknown;
}

interface PostingKey {
  tenant_id: string;
  requisition_id: string;
  channel: string;
}

@Injectable()
export class JobDistributionPostingStateRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Every tenant opted in to a channel (enabled = true). The sweep iterates these.
  async listEnabledConfigs(channel: string): Promise<TenantChannelConfigRow[]> {
    const rows = await this.prisma.tenantChannelConfig.findMany({
      where: { channel, enabled: true },
      select: { tenant_id: true, channel: true, config: true },
    });
    return rows as TenantChannelConfigRow[];
  }

  // Existing posting states for a tenant×channel — the sweep diffs the publishable
  // requisition set against these (by requisition_id).
  async listStatesForTenantChannel(
    tenant_id: string,
    channel: string,
  ): Promise<ChannelPostingStateRow[]> {
    const rows = await this.prisma.channelPostingState.findMany({
      where: { tenant_id, channel },
    });
    return rows as ChannelPostingStateRow[];
  }

  // Phase 1 — stamp the intended transition + target hash before the connector
  // call. Upsert on the (tenant, requisition, channel) identity.
  async markPending(args: {
    key: PostingKey;
    sync_status: Extract<
      SyncStatus,
      'PENDING_CREATE' | 'PENDING_UPDATE' | 'PENDING_EXPIRE'
    >;
    content_hash: string;
    external_posting_id?: string | null;
  }): Promise<void> {
    const { key, sync_status, content_hash } = args;
    await this.prisma.channelPostingState.upsert({
      where: { tenant_id_requisition_id_channel: key },
      create: {
        ...key,
        sync_status,
        content_hash,
        external_posting_id: args.external_posting_id ?? null,
      },
      update: {
        sync_status,
        content_hash,
        ...(args.external_posting_id === undefined
          ? {}
          : { external_posting_id: args.external_posting_id }),
      },
    });
  }

  // Phase 2 (success) — the upsert landed: LIVE + external id + sync timestamp.
  async markLive(args: {
    key: PostingKey;
    external_posting_id: string;
    content_hash: string;
  }): Promise<void> {
    await this.prisma.channelPostingState.update({
      where: { tenant_id_requisition_id_channel: args.key },
      data: {
        sync_status: 'LIVE',
        external_posting_id: args.external_posting_id,
        content_hash: args.content_hash,
        last_synced_at: new Date(),
      },
    });
  }

  // Phase 2 (expire success) — explicit tombstone (jobs never age out silently).
  async markExpired(key: PostingKey): Promise<void> {
    await this.prisma.channelPostingState.update({
      where: { tenant_id_requisition_id_channel: key },
      data: {
        sync_status: 'EXPIRED',
        tombstoned_at: new Date(),
        last_synced_at: new Date(),
      },
    });
  }

  // Phase 2 (failure) — ERROR is re-enterable; the next tick re-plans this row.
  async markError(key: PostingKey): Promise<void> {
    await this.prisma.channelPostingState.update({
      where: { tenant_id_requisition_id_channel: key },
      data: { sync_status: 'ERROR' },
    });
  }
}
