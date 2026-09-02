import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type {
  ReadinessDecisionResult,
  ReadinessDecisionView,
  ReadinessRefusalReason,
  RecordReadinessDecisionInput,
} from './pre-start-requirement.types.js';

interface DecisionRow {
  id: string;
  tenant_id: string;
  placement_process_id: string;
  result: string;
  refusal_reason: string | null;
  materialized: boolean;
  total_requirements: number;
  unresolved_blocking_count: number;
  actor_id: string;
  actor_type: string;
  created_at: Date;
}

function projectDecision(r: DecisionRow): ReadinessDecisionView {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    placement_process_id: r.placement_process_id,
    result: r.result as ReadinessDecisionResult,
    refusal_reason: r.refusal_reason as ReadinessRefusalReason | null,
    materialized: r.materialized,
    total_requirements: r.total_requirements,
    unresolved_blocking_count: r.unresolved_blocking_count,
    actor_id: r.actor_id,
    actor_type: r.actor_type,
    created_at: r.created_at,
  };
}

// ReadinessDecisionRepository — the append-only readiness decision ledger
// (Lane 5 / L5-P3, ruling P7). Every MARK_READY decision (success AND both refusals)
// is recorded immutably; UPDATE/DELETE are rejected at the database layer. Opaque
// UUID reference to placement.PlacementProcess (no FK, no import). The evaluated
// snapshot identity is authoritatively the immutable instance set for the placement
// and is NOT denormalized here.
@Injectable()
export class ReadinessDecisionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordReadinessDecisionInput): Promise<ReadinessDecisionView> {
    const row = (await this.prisma.preStartReadinessDecision.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        placement_process_id: input.placement_process_id,
        result: input.result,
        refusal_reason: input.refusal_reason,
        materialized: input.materialized,
        total_requirements: input.total_requirements,
        unresolved_blocking_count: input.unresolved_blocking_count,
        actor_id: input.actor_id,
        actor_type: input.actor_type,
      },
    })) as DecisionRow;
    return projectDecision(row);
  }

  async listByPlacement(
    tenant_id: string,
    placement_process_id: string,
  ): Promise<readonly ReadinessDecisionView[]> {
    const rows = (await this.prisma.preStartReadinessDecision.findMany({
      where: { tenant_id, placement_process_id },
      orderBy: { created_at: 'asc' },
    })) as DecisionRow[];
    return rows.map(projectDecision);
  }
}
