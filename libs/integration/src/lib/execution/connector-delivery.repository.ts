import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import type {
  DeliveryLedgerPort,
  DeliveryLedgerRow,
  DeliveryReservation,
} from './delivery-ledger.port.js';

// T8-CONNECTOR-A — durable delivery idempotency ledger (directive §15, Architect
// check #2). The UNIQUE(tenant_id, connection_id, delivery_key) constraint is the
// race-safe authority: a concurrent duplicate reserve() loses the insert and
// re-reads the winning row, so exactly one owner proceeds to the P2 handoff.

interface DeliveryRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  delivery_key: string;
  status: DeliveryLedgerRow['status'];
  import_batch_id: string | null;
  detail_code: string | null;
}

function toRow(r: DeliveryRow): DeliveryLedgerRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    connection_id: r.connection_id,
    delivery_key: r.delivery_key,
    status: r.status,
    import_batch_id: r.import_batch_id,
    detail_code: r.detail_code,
  };
}

/** True for a Prisma unique-constraint violation (P2002), incl. the Prisma-7 driver-adapter shape. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as {
    code?: string;
    meta?: { driverAdapterError?: { cause?: { code?: string } } };
  };
  return e.code === 'P2002' || e.meta?.driverAdapterError?.cause?.code === '23505';
}

@Injectable()
export class ConnectorDeliveryRepository implements DeliveryLedgerPort {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(
    tenantId: string,
    connectionId: string,
    deliveryKey: string,
  ): Promise<DeliveryLedgerRow | null> {
    // Tenant-first: the compound key leads with tenant_id.
    const row = (await this.prisma.connectorDelivery.findUnique({
      where: {
        tenant_id_connection_id_delivery_key: {
          tenant_id: tenantId,
          connection_id: connectionId,
          delivery_key: deliveryKey,
        },
      },
    })) as DeliveryRow | null;
    return row === null ? null : toRow(row);
  }

  async reserve(args: {
    tenant_id: string;
    connection_id: string;
    delivery_key: string;
  }): Promise<DeliveryReservation> {
    try {
      const row = (await this.prisma.connectorDelivery.create({
        data: {
          tenant_id: args.tenant_id,
          connection_id: args.connection_id,
          delivery_key: args.delivery_key,
          status: 'pending',
        },
      })) as DeliveryRow;
      return { reserved: true, row: toRow(row) };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent attempt won the insert — re-read the authoritative row.
        const existing = await this.findByKey(
          args.tenant_id,
          args.connection_id,
          args.delivery_key,
        );
        if (existing !== null) {
          return { reserved: false, row: existing };
        }
      }
      throw err;
    }
  }

  async markProcessed(id: string, importBatchId: string): Promise<void> {
    await this.prisma.connectorDelivery.update({
      where: { id },
      data: { status: 'processed', import_batch_id: importBatchId, processed_at: new Date() },
    });
  }

  async markUnsupported(id: string, detailCode: string): Promise<void> {
    await this.prisma.connectorDelivery.update({
      where: { id },
      data: { status: 'unsupported', detail_code: detailCode, processed_at: new Date() },
    });
  }

  async markFailed(id: string, detailCode: string): Promise<void> {
    await this.prisma.connectorDelivery.update({
      where: { id },
      data: { status: 'failed', detail_code: detailCode, processed_at: new Date() },
    });
  }
}
