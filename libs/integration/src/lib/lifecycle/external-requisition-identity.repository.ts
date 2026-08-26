import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// CB-D2-A1 (ADR-0030, R-IDENTITY LOCK) — the integration-owned, CONNECTION-SCOPED
// external→internal requisition identity repository.
//
// WRITE: `record` is invoked on successful connector import establishment (T8-P2)
// — idempotent upsert on (tenant, connection, external_req_id). The provider_key
// is read from the OWNING CONNECTION (never inferred from Requisition.source_system).
// A write failure is surfaced (thrown), never swallowed — the caller hard-fails so
// the establishment replays, or the first lifecycle event reconciles.
//
// READ: `resolve` returns the internal requisition_id for (tenant, connection,
// external_req_id), or null. A null resolution routes the ingress to
// reconciliation (REQUISITION_NOT_FOUND class) — NEVER a guess from source_system.

export interface RecordIdentityInput {
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly external_req_id: string;
  readonly requisition_id: string;
}

interface IdentityDbRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  external_req_id: string;
  requisition_id: string;
  provider_key: string;
}

@Injectable()
export class ExternalRequisitionIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Establish (idempotently) the connection-scoped identity for an imported
   * requisition. Reads the owning connection's provider_key (integration schema);
   * a missing connection is a caller error (the connection established the import).
   * Idempotent on (tenant, connection, external_req_id): a redelivery/replay
   * resolves to the existing row without changing requisition_id.
   */
  async record(input: RecordIdentityInput): Promise<void> {
    const connection = (await this.prisma.integrationConnection.findFirst({
      where: { tenant_id: input.tenant_id, id: input.connection_id },
      select: { provider_key: true },
    })) as { provider_key: string } | null;
    if (connection === null) {
      throw new Error(
        `ExternalRequisitionIdentity.record: connection ${input.connection_id} not found for tenant`,
      );
    }
    await this.prisma.externalRequisitionIdentity.upsert({
      where: {
        tenant_id_connection_id_external_req_id: {
          tenant_id: input.tenant_id,
          connection_id: input.connection_id,
          external_req_id: input.external_req_id,
        },
      },
      create: {
        tenant_id: input.tenant_id,
        connection_id: input.connection_id,
        external_req_id: input.external_req_id,
        requisition_id: input.requisition_id,
        provider_key: connection.provider_key,
      },
      // Idempotent — the established mapping is authoritative; do not repoint it.
      update: {},
    });
  }

  /**
   * Resolve the internal requisition_id for (tenant, connection, external_req_id),
   * or null when no identity is established (→ reconciliation, never a guess).
   */
  async resolve(
    tenantId: string,
    connectionId: string,
    externalReqId: string,
  ): Promise<string | null> {
    const row = (await this.prisma.externalRequisitionIdentity.findUnique({
      where: {
        tenant_id_connection_id_external_req_id: {
          tenant_id: tenantId,
          connection_id: connectionId,
          external_req_id: externalReqId,
        },
      },
      select: { requisition_id: true },
    })) as { requisition_id: string } | null;
    return row === null ? null : row.requisition_id;
  }

  /** Read one identity row (tenant-scoped); test/diagnostic read. */
  async findByExternalReqId(
    tenantId: string,
    connectionId: string,
    externalReqId: string,
  ): Promise<IdentityDbRow | null> {
    return (await this.prisma.externalRequisitionIdentity.findUnique({
      where: {
        tenant_id_connection_id_external_req_id: {
          tenant_id: tenantId,
          connection_id: connectionId,
          external_req_id: externalReqId,
        },
      },
    })) as IdentityDbRow | null;
  }
}
