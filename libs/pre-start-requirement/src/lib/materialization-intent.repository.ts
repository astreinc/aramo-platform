import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { IntentView, ScopeSelector } from './pre-start-requirement.types.js';

interface IntentRow {
  id: string;
  tenant_id: string;
  placement_process_id: string;
  scope: string;
  scope_ref_id: string;
  status: string;
  attempts: number;
  quarantine_reason: string | null;
  last_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function projectIntent(r: IntentRow): IntentView {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    placement_process_id: r.placement_process_id,
    scope: r.scope as IntentView['scope'],
    scope_ref_id: r.scope_ref_id,
    status: r.status as IntentView['status'],
    attempts: r.attempts,
    quarantine_reason: r.quarantine_reason,
    last_attempt_at: r.last_attempt_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// MaterializationIntentRepository — the reconciler's durable work-list + the
// per-placement idempotency root (unique per tenant + placement_process_id).
// MUTABLE by design (status/attempts advance); no immutability trigger.
//
// The intent exists because the E2 context cannot enumerate PlacementProcess
// records and must retain a durable internal work record for materialization
// recovery. It is not an event-publishing outbox.
@Injectable()
export class MaterializationIntentRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Idempotently record the intent to materialize a placement. Called when a
  // placement first enters PRE_START. If one already exists, it is returned
  // unchanged (never reset to pending — a resolved/quarantined intent stays put).
  async ensureIntent(
    tenant_id: string,
    placement_process_id: string,
    selector: ScopeSelector,
  ): Promise<IntentView> {
    const existing = (await this.prisma.preStartMaterializationIntent.findFirst({
      where: { tenant_id, placement_process_id },
    })) as IntentRow | null;
    if (existing !== null) {
      return projectIntent(existing);
    }
    try {
      const row = (await this.prisma.preStartMaterializationIntent.create({
        data: {
          id: uuidv7(),
          tenant_id,
          placement_process_id,
          scope: selector.scope,
          scope_ref_id: selector.scope_ref_id,
          status: 'pending',
          attempts: 0,
        },
      })) as IntentRow;
      return projectIntent(row);
    } catch {
      // Race-safe floor: a concurrent create won the unique index. Re-read.
      const row = (await this.prisma.preStartMaterializationIntent.findFirst({
        where: { tenant_id, placement_process_id },
      })) as IntentRow | null;
      if (row === null) throw new Error('materialization intent create raced but could not be re-read');
      return projectIntent(row);
    }
  }

  async findByPlacement(tenant_id: string, placement_process_id: string): Promise<IntentView | null> {
    const row = (await this.prisma.preStartMaterializationIntent.findFirst({
      where: { tenant_id, placement_process_id },
    })) as IntentRow | null;
    return row === null ? null : projectIntent(row);
  }

  // Pending intents ordered oldest-attempt-first (never-attempted first), for the
  // reconciler to drain. Bounded by `limit`.
  async listPending(limit: number): Promise<readonly IntentView[]> {
    const rows = (await this.prisma.preStartMaterializationIntent.findMany({
      where: { status: 'pending' },
      orderBy: [{ last_attempt_at: { sort: 'asc', nulls: 'first' } }, { created_at: 'asc' }],
      take: limit,
    })) as IntentRow[];
    return rows.map(projectIntent);
  }

  async recordAttempt(id: string): Promise<IntentView> {
    const row = (await this.prisma.preStartMaterializationIntent.update({
      where: { id },
      data: { attempts: { increment: 1 }, last_attempt_at: new Date() },
    })) as IntentRow;
    return projectIntent(row);
  }

  async markResolved(id: string): Promise<IntentView> {
    const row = (await this.prisma.preStartMaterializationIntent.update({
      where: { id },
      data: { status: 'resolved' },
    })) as IntentRow;
    return projectIntent(row);
  }

  async markQuarantined(id: string, reason: string): Promise<IntentView> {
    const row = (await this.prisma.preStartMaterializationIntent.update({
      where: { id },
      data: { status: 'quarantined', quarantine_reason: reason },
    })) as IntentRow;
    return projectIntent(row);
  }
}
