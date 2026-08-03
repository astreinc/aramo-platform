import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import type { PlacementProcessEventView } from './placement-process.types.js';

interface PlacementProcessEventRow {
  id: string;
  tenant_id: string;
  placement_process_id: string;
  event_type: 'state_transition';
  event_payload: unknown;
  created_at: Date;
}

function projectEventView(row: PlacementProcessEventRow): PlacementProcessEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    placement_process_id: row.placement_process_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
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
