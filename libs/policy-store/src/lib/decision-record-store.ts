import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { Decision, Origin } from '@aramo/policy-engine';

import type { Prisma } from '../../prisma/generated/client/client.js';

import { PrismaService } from './prisma/prisma.service.js';
import type { PolicyDecisionInputs } from './decision-inputs.js';

// PolicyDecisionRecordStore — the APPEND-ONLY write API for decision
// provenance (ADR-0024 §D17a). It records EVERY decision the caller hands
// it — ALLOW, DENY, REQUIRES_OVERRIDE, ALLOW_WITH_AUDIT — and never filters
// by outcome; a denial is the most important record to keep. There is no
// update method and no delete method: a decision record is history.
//
// This library never evaluates a policy. The caller (the engine's consumer,
// a later PR) supplies the already-computed verdict + provenance; this store
// only persists it. `policy_version` and `rule_id` are required inputs — for
// a default-disposition no-match the caller passes the engine's `__default__`
// marker.
//
// @Injectable so a future PR can wire it via DI; no NestJS module/controller/
// endpoint and no consumers here. Tests construct it directly.

/** One decision to record. All §D17a fields; `inputs` is the PII-free snapshot. */
export interface RecordPolicyDecisionInput {
  readonly tenant_id: string;
  readonly decision: Decision;
  readonly policy_version: string;
  readonly rule_id: string;
  readonly reason_code: string;
  readonly resource: string;
  readonly action: string;
  readonly inputs: PolicyDecisionInputs;
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
  /** When the decision was evaluated. Defaults to now. */
  readonly occurred_at?: Date;
}

/** A persisted decision record, read back. */
export interface PolicyDecisionRecord {
  readonly id: string;
  readonly tenant_id: string;
  readonly decision: Decision;
  readonly policy_version: string;
  readonly rule_id: string;
  readonly reason_code: string;
  readonly resource: string;
  readonly action: string;
  readonly inputs: PolicyDecisionInputs;
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
  readonly occurred_at: Date;
}

interface DecisionRow {
  id: string;
  tenant_id: string;
  decision: string;
  policy_version: string;
  rule_id: string;
  reason_code: string;
  resource: string;
  action: string;
  inputs: Prisma.JsonValue;
  actor_id: string;
  origin: string;
  correlation_id: string;
  occurred_at: Date;
}

@Injectable()
export class PolicyDecisionRecordStore {
  constructor(private readonly prisma: PrismaService) {}

  private static toRecord(row: DecisionRow): PolicyDecisionRecord {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      decision: row.decision as Decision,
      policy_version: row.policy_version,
      rule_id: row.rule_id,
      reason_code: row.reason_code,
      resource: row.resource,
      action: row.action,
      inputs: row.inputs as unknown as PolicyDecisionInputs,
      actor_id: row.actor_id,
      origin: row.origin as Origin,
      correlation_id: row.correlation_id,
      occurred_at: row.occurred_at,
    };
  }

  /** Append one decision record. The only write path — history, never mutated. */
  async record(input: RecordPolicyDecisionInput): Promise<PolicyDecisionRecord> {
    const row = (await this.prisma.policyDecisionRecord.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        decision: input.decision,
        policy_version: input.policy_version,
        rule_id: input.rule_id,
        reason_code: input.reason_code,
        resource: input.resource,
        action: input.action,
        inputs: input.inputs as unknown as Prisma.InputJsonValue,
        actor_id: input.actor_id,
        origin: input.origin,
        correlation_id: input.correlation_id,
        ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
      },
    })) as DecisionRow;
    return PolicyDecisionRecordStore.toRecord(row);
  }

  /** Read one record by id (tenant-scoped), or null. */
  async getById(tenantId: string, id: string): Promise<PolicyDecisionRecord | null> {
    const row = (await this.prisma.policyDecisionRecord.findFirst({
      where: { tenant_id: tenantId, id },
    })) as DecisionRow | null;
    return row === null ? null : PolicyDecisionRecordStore.toRecord(row);
  }

  /** All records for one command (correlation id), oldest first. Tenant-scoped. */
  async listByCorrelation(tenantId: string, correlationId: string): Promise<PolicyDecisionRecord[]> {
    const rows = (await this.prisma.policyDecisionRecord.findMany({
      where: { tenant_id: tenantId, correlation_id: correlationId },
      orderBy: { occurred_at: 'asc' },
    })) as DecisionRow[];
    return rows.map((row) => PolicyDecisionRecordStore.toRecord(row));
  }

  /** All records for one tenant, newest first. Tenant isolation via the predicate. */
  async listByTenant(tenantId: string): Promise<PolicyDecisionRecord[]> {
    const rows = (await this.prisma.policyDecisionRecord.findMany({
      where: { tenant_id: tenantId },
      orderBy: { occurred_at: 'desc' },
    })) as DecisionRow[];
    return rows.map((row) => PolicyDecisionRecordStore.toRecord(row));
  }
}
