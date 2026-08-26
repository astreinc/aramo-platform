import { Injectable } from '@nestjs/common';

import type {
  ConnectionStatus,
  IntegrationConnectionRow,
} from '../domain/integration-connection.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ConnectionSecretLoaderPort } from '../secrets/connector-secret-resolver.js';

// T8-CONNECTOR-A — tenant-first connection persistence (directive §13/§33).
// Every query LEADS with tenant_id; a cross-tenant id is NOT FOUND (tenant-safe),
// never an info leak. Also implements the resolver's narrow secret-loader port so
// secret derivation is always driven by a tenant-owned DB row.

interface ConnectionDbRow {
  id: string;
  tenant_id: string;
  provider_key: string;
  status: ConnectionStatus;
  secret_ref: string | null;
  config: unknown;
  provider_account_id: string | null;
  cursor: string | null;
  last_attempted_at: Date | null;
  last_successful_at: Date | null;
  last_error_code: string | null;
  last_error_summary: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toRow(r: ConnectionDbRow): IntegrationConnectionRow {
  return { ...r };
}

@Injectable()
export class IntegrationConnectionRepository implements ConnectionSecretLoaderPort {
  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    tenant_id: string;
    provider_key: string;
    config?: unknown;
    provider_account_id?: string | null;
  }): Promise<IntegrationConnectionRow> {
    const row = (await this.prisma.integrationConnection.create({
      data: {
        tenant_id: args.tenant_id,
        provider_key: args.provider_key,
        status: 'disconnected',
        config: (args.config ?? undefined) as never,
        provider_account_id: args.provider_account_id ?? null,
      },
    })) as ConnectionDbRow;
    return toRow(row);
  }

  /** Tenant-safe read — returns null when the id belongs to another tenant. */
  async findByIdForTenant(
    tenantId: string,
    id: string,
  ): Promise<IntegrationConnectionRow | null> {
    const row = (await this.prisma.integrationConnection.findFirst({
      where: { tenant_id: tenantId, id },
    })) as ConnectionDbRow | null;
    return row === null ? null : toRow(row);
  }

  /**
   * COMM-B3 — resolve the tenant's USABLE connection for a provider_key
   * (tenant-safe; provider-neutral — the caller supplies the key, the substrate
   * knows no vendor). Only a `configured` or `active` connection is returned
   * (a `disconnected`/`disabled`/`degraded` one is not usable); most-recently-
   * updated wins when several exist (no unique(tenant, provider_key) by design).
   */
  async findByProviderKeyForTenant(
    tenantId: string,
    providerKey: string,
  ): Promise<IntegrationConnectionRow | null> {
    const row = (await this.prisma.integrationConnection.findFirst({
      where: {
        tenant_id: tenantId,
        provider_key: providerKey,
        status: { in: ['configured', 'active'] },
      },
      orderBy: { updated_at: 'desc' },
    })) as ConnectionDbRow | null;
    return row === null ? null : toRow(row);
  }

  async listForTenant(tenantId: string): Promise<IntegrationConnectionRow[]> {
    const rows = (await this.prisma.integrationConnection.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
    })) as ConnectionDbRow[];
    return rows.map(toRow);
  }

  /**
   * ConnectionSecretLoaderPort — the tenant-scoped load the resolver drives from.
   * A connection owned by a different tenant is NOT FOUND.
   */
  async findConnectionForTenant(
    tenantId: string,
    connectionId: string,
  ): Promise<{ id: string; tenant_id: string; secret_ref: string | null } | null> {
    const row = (await this.prisma.integrationConnection.findFirst({
      where: { tenant_id: tenantId, id: connectionId },
      select: { id: true, tenant_id: true, secret_ref: true },
    })) as { id: string; tenant_id: string; secret_ref: string | null } | null;
    return row;
  }

  /**
   * Attach an opaque secret_ref and advance to `configured` (tenant-scoped write).
   * Returns the row count updated (0 → tenant-safe miss).
   */
  async setSecretRef(tenantId: string, id: string, secretRef: string): Promise<number> {
    const res = await this.prisma.integrationConnection.updateMany({
      where: { tenant_id: tenantId, id },
      data: { secret_ref: secretRef, status: 'configured', version: { increment: 1 } },
    });
    return res.count;
  }

  /** Update non-secret config/account metadata (tenant-scoped). NEVER touches secret_ref. */
  async updateConfig(
    tenantId: string,
    id: string,
    patch: { config?: unknown; provider_account_id?: string | null },
  ): Promise<number> {
    const data: Record<string, unknown> = { version: { increment: 1 } };
    if (patch.config !== undefined) data['config'] = patch.config;
    if (patch.provider_account_id !== undefined)
      data['provider_account_id'] = patch.provider_account_id;
    const res = await this.prisma.integrationConnection.updateMany({
      where: { tenant_id: tenantId, id },
      data: data as never,
    });
    return res.count;
  }

  async setStatus(tenantId: string, id: string, status: ConnectionStatus): Promise<number> {
    const res = await this.prisma.integrationConnection.updateMany({
      where: { tenant_id: tenantId, id },
      data: { status, version: { increment: 1 } },
    });
    return res.count;
  }

  async recordAttempt(tenantId: string, id: string): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { tenant_id: tenantId, id },
      data: { last_attempted_at: new Date() },
    });
  }

  async recordSuccess(tenantId: string, id: string): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { tenant_id: tenantId, id },
      data: {
        last_successful_at: new Date(),
        last_error_code: null,
        last_error_summary: null,
        status: 'active',
      },
    });
  }

  async recordError(
    tenantId: string,
    id: string,
    errorCode: string,
    errorSummary: string,
  ): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { tenant_id: tenantId, id },
      data: {
        last_error_code: errorCode,
        last_error_summary: errorSummary.slice(0, 500),
        status: 'degraded',
      },
    });
  }

  /**
   * CB-D2-A1 (R-DURABILITY) — advance the connection's opaque polling cursor.
   * Called ONLY after a lifecycle fetch is fully processed (persist-then-process):
   * the cursor is the "since last download" watermark, never advanced ahead of
   * durable ingress. Tenant-scoped; returns the row count updated (0 → miss).
   */
  async advanceCursor(tenantId: string, id: string, cursor: string | null): Promise<number> {
    const res = await this.prisma.integrationConnection.updateMany({
      where: { tenant_id: tenantId, id },
      data: { cursor, version: { increment: 1 } },
    });
    return res.count;
  }

  /**
   * CB-D2-A1 (R-PRODUCER) — the ACTIVE connections a lifecycle poll should sweep
   * (all tenants; the scheduled producer is tenant-agnostic). Only `active`
   * connections are polled; the caller resolves a LifecycleSourceAdapter per
   * provider_key and skips any with no registered source.
   */
  async listActiveForLifecyclePoll(): Promise<
    Array<{ id: string; tenant_id: string; provider_key: string; cursor: string | null }>
  > {
    const rows = (await this.prisma.integrationConnection.findMany({
      where: { status: 'active' },
      select: { id: true, tenant_id: true, provider_key: true, cursor: true },
      orderBy: { updated_at: 'asc' },
    })) as Array<{ id: string; tenant_id: string; provider_key: string; cursor: string | null }>;
    return rows;
  }
}
