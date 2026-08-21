import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type AramoLogger } from '@aramo/common';
import { insertActivityInTx } from '@aramo/activity';
import { recordUsage } from '@aramo/metering';
import { canTransitionSubmittal } from '@aramo/submittal';
import { canTransition as canTransitionPipeline } from '@aramo/pipeline';
import {
  consumeSlot,
  evaluateEligibility,
  type SubmittalPolicyInputs,
} from '@aramo/submittal-eligibility';

// Lane L8-B1 (v1.2) — the "Submit Talent to Client" orchestration command.
//
// THE single authoritative client-submittal operation. One interactive
// PostgreSQL transaction on ONE connection at the apps/api composition layer
// (§6 Approach A); cross-schema SQL confined to THIS boundary. Business
// invariants stay single-sourced: transition legality via the imported
// `canTransition*` state machines, activity/metering/consumption via the
// imported connection-agnostic helpers. Nothing re-encodes a business rule.
//
// Order (§6 + §7 Amendment A1): read+lock submittal → submittal state machine →
// resolve pipeline via `submittal.pipeline_id` (tenant+req+talent identity match
// + LIVE + canTransition, else SUBMITTAL_PIPELINE_LINK_INVALID) → eligibility →
// serialized consumeSlot → `submitted_to_ats` (authoritative) + event + outbox +
// usage → pipeline `submitted` MIRROR + history + activity + usage → policy
// provenance → commit. Any failure rolls back EVERYTHING.

// LIVE = the E6 live-episode predicate (mirror of the partial-unique WHERE).
const NON_LIVE_PIPELINE_STATUSES = new Set([
  'placed',
  'not_in_consideration',
  'client_declined',
]);

export interface SubmitTalentToClientInput {
  readonly tenant_id: string;
  readonly submittal_id: string;
  /** Deterministic id for the submittal state_transition event (idempotency). */
  readonly event_id: string;
  readonly actor_id: string;
  readonly note?: string | null;
  readonly requestId: string;
}

export interface SubmitTalentToClientResult {
  readonly submittal_id: string;
  readonly pipeline_id: string;
  readonly state: 'submitted_to_ats';
  readonly pipeline_status: 'submitted';
}

interface SubmittalRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly job_id: string;
  readonly pipeline_id: string | null;
  readonly state: string;
}
interface PipelineRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly site_id: string | null;
  readonly status: string;
}

// Minimal DB surface the orchestrator needs — a $transaction whose interactive
// client issues parameterized raw SQL. A concrete per-module PrismaService
// (bound at the module via the 'SubmitTalentDb' token) satisfies this
// structurally; typing against the interface avoids leaking a lib's generated
// Prisma client type across the apps/api boundary. Satisfies consumeSlot's RawTx
// ($queryRawUnsafe) and the metering/activity helpers' PrismaRawCapable
// ($executeRaw).
interface RawTxClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $executeRaw(template: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}
interface OrchestratorDb {
  $transaction<T>(fn: (tx: RawTxClient) => Promise<T>): Promise<T>;
}

@Injectable()
export class SubmitTalentToClientService {
  constructor(
    @Inject('SubmitTalentDb') private readonly db: OrchestratorDb,
    @Inject('SubmitTalentToClientLogger') private readonly logger: AramoLogger,
  ) {}

  async submitToClient(
    input: SubmitTalentToClientInput,
  ): Promise<SubmitTalentToClientResult> {
    const { tenant_id, submittal_id, requestId } = input;
    const err = (
      code: string,
      message: string,
      status: number,
      details: Record<string, unknown>,
    ) =>
      new AramoError(code as never, message, status, { requestId, details });

    return this.db.$transaction(async (tx) => {
      // 1 — read + lock the submittal (serializes concurrent submits of the SAME submittal).
      const subs = await tx.$queryRawUnsafe<SubmittalRow[]>(
        `SELECT "id","tenant_id","talent_id","job_id","pipeline_id","state"
           FROM "submittal"."TalentSubmittalRecord"
          WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid FOR UPDATE`,
        submittal_id,
        tenant_id,
      );
      const submittal = subs[0];
      if (submittal === undefined) {
        throw err('NOT_FOUND', 'TalentSubmittalRecord not found', 404, {
          submittal_id,
        });
      }

      // 2 — submittal state machine (single-sourced).
      if (!canTransitionSubmittal(submittal.state as never, 'submitted_to_ats')) {
        throw err(
          'SUBMITTAL_STATE_INVALID',
          `Illegal submittal state transition: ${submittal.state} -> submitted_to_ats`,
          422,
          { submittal_id, from_state: submittal.state },
        );
      }

      // 3 — resolve + validate the linked pipeline (R-LINK / R-REFUSAL + identity match).
      if (submittal.pipeline_id === null) {
        throw err(
          'SUBMITTAL_PIPELINE_LINK_INVALID',
          'Submittal has no linked pipeline episode',
          409,
          { submittal_id },
        );
      }
      const pipes = await tx.$queryRawUnsafe<PipelineRow[]>(
        `SELECT "id","tenant_id","talent_record_id","requisition_id","site_id","status"
           FROM "pipeline"."Pipeline" WHERE "id" = $1::uuid FOR UPDATE`,
        submittal.pipeline_id,
      );
      const pipeline = pipes[0];
      const linkInvalid = (reason: string) =>
        err(
          'SUBMITTAL_PIPELINE_LINK_INVALID',
          `Linked pipeline episode is not valid for this submittal: ${reason}`,
          409,
          { submittal_id, pipeline_id: submittal.pipeline_id, reason },
        );
      if (pipeline === undefined) throw linkInvalid('not_found');
      // IDENTITY MATCH — same tenant, requisition, and Talent as the submittal.
      if (pipeline.tenant_id !== submittal.tenant_id) throw linkInvalid('tenant_mismatch');
      if (pipeline.requisition_id !== submittal.job_id) throw linkInvalid('requisition_mismatch');
      if (pipeline.talent_record_id !== submittal.talent_id) throw linkInvalid('talent_mismatch');
      if (NON_LIVE_PIPELINE_STATUSES.has(pipeline.status)) throw linkInvalid('not_live');
      if (!canTransitionPipeline(pipeline.status as never, 'submitted')) {
        throw linkInvalid('illegal_transition');
      }

      const requisition_id = submittal.job_id;
      const talent_record_id = submittal.talent_id;

      // 4 — eligibility gate (deadline / manual override / client restriction). The
      // slot LIMIT is enforced authoritatively by consumeSlot under the policy lock.
      const inputs = await this.readPolicyInputs(tx, tenant_id, requisition_id);
      const consumedRows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS "n" FROM "submittal_policy"."SubmittalConsumption"
          WHERE "tenant_id" = $1::uuid AND "requisition_id" = $2::uuid`,
        tenant_id,
        requisition_id,
      );
      const restriction_active = await this.isRestrictedAtClient(
        tx,
        tenant_id,
        requisition_id,
        talent_record_id,
      );
      const decision = evaluateEligibility(inputs, {
        now: new Date(),
        consumed_count: consumedRows[0]?.n ?? 0,
        restriction_active,
      });
      if (!decision.eligible && decision.deny !== undefined) {
        throw err(decision.deny, `Submittal not eligible: ${decision.deny}`, 409, {
          submittal_id,
          requisition_id,
        });
      }

      // 5 — serialized slot consumption (proven; FOR UPDATE on the policy row).
      const consume = await consumeSlot(tx, {
        tenant_id,
        requisition_id,
        talent_record_id,
        submittal_id,
        limit: inputs.submittal_limit,
      });
      if (consume.status === 'LIMIT_REACHED') {
        throw err(
          'SUBMITTAL_LIMIT_REACHED',
          'Supplier submittal slot limit reached',
          409,
          { submittal_id, requisition_id },
        );
      }

      // 6 — authoritative submittal write: submitted_to_ats + event + outbox + usage.
      await tx.$executeRawUnsafe(
        `UPDATE "submittal"."TalentSubmittalRecord"
            SET "state" = 'submitted_to_ats', "confirmed_at" = NOW()
          WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
        submittal_id,
        tenant_id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "submittal"."TalentSubmittalEvent"
           ("id","tenant_id","submittal_id","event_type","event_payload","created_at")
         VALUES ($1::uuid,$2::uuid,$3::uuid,'state_transition',$4::jsonb,NOW())`,
        input.event_id,
        tenant_id,
        submittal_id,
        JSON.stringify({ from_state: submittal.state, to_state: 'submitted_to_ats' }),
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "submittal"."OutboxEvent"
           ("id","tenant_id","event_type","event_payload","created_at")
         VALUES ($1::uuid,$2::uuid,'submittal.state_transition',$3::jsonb,NOW())`,
        uuidv7(),
        tenant_id,
        JSON.stringify({
          submittal_id,
          tenant_id,
          from_state: submittal.state,
          to_state: 'submitted_to_ats',
          transition_event_id: input.event_id,
        }),
      );
      await recordUsage(tx, { tenant_id, event_type: 'submittal.state_transition' });

      // 7 — pipeline MIRROR: submitted + history + activity + usage.
      await tx.$executeRawUnsafe(
        `UPDATE "pipeline"."Pipeline" SET "status" = 'submitted'
          WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
        pipeline.id,
        tenant_id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "pipeline"."PipelineStatusHistory"
           ("id","tenant_id","pipeline_id","status_from","status_to","changed_by_id","changed_at","note")
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::"pipeline"."PipelineStatus",'submitted',$5::uuid,NOW(),$6)`,
        uuidv7(),
        tenant_id,
        pipeline.id,
        pipeline.status,
        input.actor_id,
        input.note ?? null,
      );
      await insertActivityInTx(tx, {
        tenant_id,
        ...(pipeline.site_id === null ? {} : { site_id: pipeline.site_id }),
        type: 'pipeline_status_change',
        subject_type: 'pipeline',
        subject_id: pipeline.id,
        notes: `pipeline ${pipeline.status} -> submitted (client submittal ${submittal_id})`,
        created_by_id: input.actor_id,
      });
      await recordUsage(tx, { tenant_id, event_type: 'pipeline.state_transition' });

      // 8 — policy provenance (append-only).
      await tx.$executeRawUnsafe(
        `INSERT INTO "submittal_policy"."SubmittalPolicyEvent"
           ("id","tenant_id","requisition_id","authority","origin","effective_at","occurred_at")
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::"submittal_policy"."SubmittalAuthority",'system',NOW(),NOW())`,
        uuidv7(),
        tenant_id,
        requisition_id,
        inputs.submittal_authority,
      );

      this.logger.log({
        event: 'submit_talent_to_client',
        tenant_id,
        submittal_id,
        pipeline_id: pipeline.id,
        requisition_id,
        consumption: consume.status,
      });
      return {
        submittal_id,
        pipeline_id: pipeline.id,
        state: 'submitted_to_ats',
        pipeline_status: 'submitted',
      };
    });
  }

  private async readPolicyInputs(
    tx: RawTxClient,
    tenant_id: string,
    requisition_id: string,
  ): Promise<SubmittalPolicyInputs> {
    const rows = await tx.$queryRawUnsafe<
      Array<{
        submittal_deadline: Date | null;
        submittal_limit: number | null;
        manual_override: string | null;
        submittal_authority: string;
      }>
    >(
      `SELECT "submittal_deadline","submittal_limit","manual_override","submittal_authority"
         FROM "submittal_policy"."RequisitionSubmittalPolicy"
        WHERE "tenant_id" = $1::uuid AND "requisition_id" = $2::uuid`,
      tenant_id,
      requisition_id,
    );
    const row = rows[0];
    if (row === undefined) {
      return {
        submittal_deadline: null,
        submittal_limit: null,
        manual_override: null,
        submittal_authority: 'ARAMO',
      };
    }
    return {
      submittal_deadline: row.submittal_deadline,
      submittal_limit: row.submittal_limit,
      manual_override: row.manual_override as never,
      submittal_authority: row.submittal_authority as never,
    };
  }

  private async isRestrictedAtClient(
    tx: RawTxClient,
    tenant_id: string,
    requisition_id: string,
    talent_record_id: string,
  ): Promise<boolean> {
    const reqRows = await tx.$queryRawUnsafe<Array<{ company_id: string }>>(
      `SELECT "company_id" FROM "requisition"."Requisition"
        WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
      requisition_id,
      tenant_id,
    );
    const company_id = reqRows[0]?.company_id;
    if (company_id === undefined) return false;
    const restr = await tx.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS "one" FROM "client_talent_restriction"."ClientTalentRestriction"
        WHERE "tenant_id" = $1::uuid AND "client_company_id" = $2::uuid
          AND "talent_record_id" = $3::uuid
          AND "effective_from" <= NOW()
          AND ("scheduled_end_at" IS NULL OR "scheduled_end_at" > NOW())
          AND ("effective_to" IS NULL OR "effective_to" > NOW())
        LIMIT 1`,
      tenant_id,
      company_id,
      talent_record_id,
    );
    return restr.length > 0;
  }
}
