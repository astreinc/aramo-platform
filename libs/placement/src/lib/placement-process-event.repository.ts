import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import type { PlacementProcessEventView } from './placement-process.types.js';

interface PlacementProcessEventRow {
  id: string;
  tenant_id: string;
  placement_process_id: string;
  event_type: 'state_transition';
  event_payload: unknown;
  reason_code: string | null;
  reason_label_snapshot: string | null;
  reason_detail: string | null;
  created_at: Date;
}

function projectEventView(row: PlacementProcessEventRow): PlacementProcessEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    placement_process_id: row.placement_process_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
    // E3 — reason evidence surfaced on the read view. Null = legacy/non-governed
    // absence, distinguished from a present canonical reason. reason_detail is
    // tenant-owned PII; an HTTP read surface (E1-d) must gate its exposure to
    // roles already permitted to see placement evidence.
    reason_code: row.reason_code ?? null,
    reason_label_snapshot: row.reason_label_snapshot ?? null,
    reason_detail: row.reason_detail ?? null,
    created_at: row.created_at,
  };
}

// PlacementProcessEventRepository — READ surface over the append-only event
// log (Track 3 / E1-a §9). Appends are written inline in the transition
// transaction (PlacementRepository); the log has no update or delete path
// here, and the database triggers reject both regardless (§3).
@Injectable()
export class PlacementProcessEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listEvents(tenant_id: string, placement_process_id: string): Promise<PlacementProcessEventView[]> {
    const rows = (await this.prisma.placementProcessEvent.findMany({
      where: { tenant_id, placement_process_id },
      orderBy: { created_at: 'asc' },
    })) as PlacementProcessEventRow[];
    return rows.map(projectEventView);
  }
}
