import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError, type AramoLogger } from '@aramo/common';
import { recordUsage } from '@aramo/metering';
import { canTransitionSubmittal } from '@aramo/submittal';
import { isLiveStatus, type PipelineStatus } from '@aramo/pipeline';
import {
  consumeSlot,
  evaluateEligibility,
  isRequisitionSubmittable,
  pipelineLinkVerdict,
  type SubmittalPolicyInputs,
} from '@aramo/submittal-eligibility';
import {
  CLIENT_SUBMITTAL_ACTION,
  CLIENT_SUBMITTAL_RESOURCE,
  ClientSubmittalPolicyService,
} from '@aramo/client-submittal-policy';
import { insertPolicyDecisionRecordInTx } from '@aramo/policy-store';

import { EngagementGateService } from '../engagement/engagement-gate.service.js';
import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';

// Lane L8-B1 (v1.2) — the "Submit Talent to Client" orchestration command.
//
// THE single authoritative client-submittal operation. One interactive
// PostgreSQL transaction on ONE connection at the apps/api composition layer
// (§6 Approach A); cross-schema SQL confined to THIS boundary. Business
// invariants stay single-sourced: transition legality via the imported
// `canTransition*` state machines, activity/metering/consumption via the
// imported connection-agnostic helpers. Nothing re-encodes a business rule.
//
// Order (§6 + §7 Amendment A1; Lane 2 / L2-E): read+lock submittal → submittal
// state machine → resolve pipeline via `submittal.pipeline_id` (tenant+req+talent
// identity match + LIVE, else SUBMITTAL_PIPELINE_LINK_INVALID) → eligibility →
// serialized consumeSlot → `submitted_to_client` (authoritative) + event + outbox +
// usage → policy provenance → commit. Any failure rolls back EVERYTHING. L2-E (SB-5)
// retired the Pipeline mirror: this command no longer writes Pipeline —
// the episode stays LIVE and readers derive the submit-to-client signal from the event.

// SW-1 (Submittal Workspace, R1-A) — the live-episode predicate is the Pipeline
// domain's canonical `isLiveStatus` (single authority), NOT a local set. This
// reconciles the prior two-value drift: `voided` is a canonical terminal
// (LIVE_EPISODE_EXCLUSION_STATUSES / the Pipeline_live_episode_key partial index),
// so a voided episode is correctly NON-live here too. Submit re-validates the link
// fail-closed regardless of how the submittal's pipeline_id was derived at create.

// SW-2 (R4-B) — the ACTUAL delivery-channel vocabulary (provenance). Mirrors the
// submittal.SubmittalDeliveryChannel enum. Manual channels are the V1 reality;
// aramo_connector exists for forward-compat only (refused at submit until an outbound
// connector exists).
const ALL_DELIVERY_CHANNELS = new Set<string>([
  'manual_vms',
  'manual_client_portal',
  'manual_email',
  'manual_other',
  'aramo_connector',
]);

export interface SubmitTalentToClientInput {
  readonly tenant_id: string;
  readonly submittal_id: string;
  /** Deterministic id for the submittal state_transition event (idempotency). */
  readonly event_id: string;
  readonly actor_id: string;
  readonly note?: string | null;
  readonly requestId: string;
  /**
   * COMM PART A — the actor holds `engagement:policy:override` (resolved from the
   * caller's scopes). Authority is scope-based, never a role name.
   */
  readonly actor_can_override?: boolean;
  /** COMM PART A — an explicit engagement-policy override with a recorded reason. */
  readonly engagement_override?: { readonly reason: string } | undefined;
  // CSP PR-3 — whether the actor holds client-submittal-policy:override (JWT-frozen
  // scope membership; never a role name), and the recorded override reason.
  readonly submittal_actor_can_override?: boolean;
  readonly submittal_override_reason?: string | null;
  // SW-2 (R4-A/R4-B) — V1 submittal delivery provenance (how the client handoff
  // ACTUALLY happened). All optional: captured when the caller provides them;
  // submitted_at / submitted_by_actor_id are always set from NOW()/actor_id, and the
  // client-facing rate is frozen from the requisition when present.
  readonly delivery_channel?: string | null;
  readonly external_reference?: string | null;
  readonly external_submitted_at?: string | null;
}

export interface SubmitTalentToClientResult {
  readonly submittal_id: string;
  readonly pipeline_id: string;
  readonly state: 'submitted_to_client';
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
    // COMM-C3 — the engagement gate (composition-root); resolves policy + neutral
    // evidence + provenance on its OWN connections and returns the typed verdict.
    private readonly engagementGate: EngagementGateService,
    // DOC-5 — the document-readiness (RTR) gate; resolves the same-document
    // executed-RTR verdict on its own connection. Checked LAST in the order.
    private readonly documentReadiness: DocumentReadinessGate,
    // CSP PR-3 — the Client Submittal Policy service; resolves the effective per-
    // client policy (StoredPolicyVersion layers) and decides via the generic engine.
    private readonly clientSubmittalPolicy: ClientSubmittalPolicyService,
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
      if (!canTransitionSubmittal(submittal.state as never, 'submitted_to_client')) {
        throw err(
          'SUBMITTAL_STATE_INVALID',
          `Illegal submittal state transition: ${submittal.state} -> submitted_to_client`,
          422,
          { submittal_id, from_state: submittal.state },
        );
      }

      // 3 — resolve + validate the linked pipeline (R-LINK / R-REFUSAL + identity match).
      // The pipeline row is still read in-tx (FOR UPDATE) for atomicity, but the link
      // RULE is the shared `pipelineLinkVerdict` — the IDENTICAL rule the unified
      // evaluateSubmittalReadiness authority composes (SW-3), so submit + readiness
      // never diverge. isLiveStatus is the Pipeline domain's canonical live predicate.
      let pipeline: PipelineRow | undefined;
      if (submittal.pipeline_id !== null) {
        const pipes = await tx.$queryRawUnsafe<PipelineRow[]>(
          `SELECT "id","tenant_id","talent_record_id","requisition_id","site_id","status"
             FROM "pipeline"."Pipeline" WHERE "id" = $1::uuid FOR UPDATE`,
          submittal.pipeline_id,
        );
        pipeline = pipes[0];
      }
      const linkVerdict = pipelineLinkVerdict({
        pipeline_id: submittal.pipeline_id,
        episode:
          pipeline !== undefined
            ? {
                tenant_id: pipeline.tenant_id,
                requisition_id: pipeline.requisition_id,
                talent_record_id: pipeline.talent_record_id,
              }
            : null,
        episode_is_live:
          pipeline !== undefined && isLiveStatus(pipeline.status as PipelineStatus),
        expected: {
          tenant_id: submittal.tenant_id,
          requisition_id: submittal.job_id,
          talent_id: submittal.talent_id,
        },
      });
      if (!linkVerdict.ok) {
        // Preserve the exact refusal envelope: 'missing' carries only submittal_id;
        // every identity/liveness reason carries pipeline_id + the reason.
        if (linkVerdict.reason === 'missing') {
          throw err('SUBMITTAL_PIPELINE_LINK_INVALID', 'Submittal has no linked pipeline episode', 409, {
            submittal_id,
          });
        }
        throw err(
          'SUBMITTAL_PIPELINE_LINK_INVALID',
          `Linked pipeline episode is not valid for this submittal: ${linkVerdict.reason}`,
          409,
          { submittal_id, pipeline_id: submittal.pipeline_id, reason: linkVerdict.reason },
        );
      }
      // linkVerdict.ok guarantees a live, identity-matched episode (narrows for TS).
      if (pipeline === undefined) {
        throw err('SUBMITTAL_PIPELINE_LINK_INVALID', 'Linked pipeline episode is not valid for this submittal: not_found', 409, {
          submittal_id,
          pipeline_id: submittal.pipeline_id,
          reason: 'not_found',
        });
      }

      const requisition_id = submittal.job_id;
      const talent_record_id = submittal.talent_id;

      // 3b — L1-C (Rule 1) SUBMIT gate: a new client submittal is allowed only
      // when the requisition's RecruitingStatus is `open`. Read in-tx via the
      // same raw-SQL route isRestrictedAtClient uses (no CIP RequisitionStateReader
      // injection — that would cross the wrong nx edge), so all three gates stay
      // atomic. The row absent OR status !== 'open' refuses with REQUISITION_NOT_OPEN
      // (409) — no free pass for a missing requisition. details.status carries the
      // current status (null when absent). This gate only READS status; it never
      // writes it (Rule 3 / H4 one-way).
      const reqStatusRows = await tx.$queryRawUnsafe<
        Array<{
          status: string;
          company_id: string | null;
          bill_rate_amount: string | number | null;
          bill_rate_currency: string | null;
          bill_rate_period: string | null;
        }>
      >(
        // SW-2 (R4-A) — also read the bill-rate VALUE + currency + period so the send
        // can FREEZE a client-facing commercial snapshot onto the submittal (historical
        // truth). The live requisition remains the sole editable commercial authority.
        `SELECT "status","company_id","bill_rate_amount","bill_rate_currency","bill_rate_period"
           FROM "requisition"."Requisition"
          WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
        requisition_id,
        tenant_id,
      );
      const requisition_status = reqStatusRows[0]?.status;
      const company_id = reqStatusRows[0]?.company_id ?? null;
      // CSP PR-3 — Client Submittal Policy fact: a bill rate is recorded on the requisition.
      const bill_rate_amount = reqStatusRows[0]?.bill_rate_amount ?? null;
      const bill_rate_currency = reqStatusRows[0]?.bill_rate_currency ?? null;
      const bill_rate_period = reqStatusRows[0]?.bill_rate_period ?? null;
      const bill_rate_present = bill_rate_amount != null;
      // SW-3 — the SAME shared rule the unified readiness authority composes.
      if (!isRequisitionSubmittable(requisition_status ?? null)) {
        throw err(
          'REQUISITION_NOT_OPEN',
          'The requisition must be open before Talent can be submitted to the client',
          409,
          { submittal_id, requisition_id, status: requisition_status ?? null },
        );
      }

      // TALENT-INTEL-1 TI-1D-D (Layer B) — the exact resume edition sent to the
      // client is the CURRENT explicit working selection (TalentRequisitionResume,
      // latest selected_at) for (tenant, talent, requisition). REQUIRE it — there
      // is NO automatic Talent-default fallback (the default is only a suggestion,
      // never authoritative for a requisition). Ordered AFTER the structural /
      // requisition-open gates and BEFORE the eligibility/engagement gate (so no
      // engagement provenance is written on a selection-missing refusal). Resolved
      // in-tx via raw SQL (no cross-lib injection); snapshotted onto the submittal
      // at the send transition below and frozen by the immutability trigger —
      // provable regardless of later selection/default changes.
      const selectionRows = await tx.$queryRawUnsafe<Array<{ resume_edition_id: string }>>(
        `SELECT "resume_edition_id" FROM "pipeline"."TalentRequisitionResume"
           WHERE "tenant_id" = $1::uuid AND "talent_record_id" = $2::uuid AND "requisition_id" = $3::uuid
           ORDER BY "selected_at" DESC
           LIMIT 1`,
        tenant_id,
        talent_record_id,
        requisition_id,
      );
      const resume_edition_id = selectionRows[0]?.resume_edition_id;
      if (resume_edition_id === undefined) {
        throw err(
          'SUBMITTAL_RESUME_SELECTION_REQUIRED',
          'A resume edition must be explicitly selected for this requisition before submitting to the client',
          422,
          { submittal_id, requisition_id },
        );
      }

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
      // COMM-C3 — the engagement gate (R1/C3-7): runs AFTER the existing
      // eligibility inputs are gathered and BEFORE slot consumption/mutation. The
      // gate resolves the effective policy + provider-neutral evidence and writes
      // append-only provenance on its OWN connections (surviving a deny abort); the
      // pure decision below denies with the carried typed reason when unsatisfied.
      const engagement = await this.engagementGate.assess({
        tenant_id,
        talent_id: talent_record_id,
        requisition_id,
        submittal_id,
        company_id,
        actor_id: input.actor_id,
        actor_can_override: input.actor_can_override ?? false,
        override: input.engagement_override,
        correlation_id: requestId,
      });
      // DOC-5 — document-readiness (RTR) gate, resolved after engagement, before
      // the pure decision. The gate reads Documents on its own connection (never
      // mutates Submittal); the pure decision denies LAST with the carried reason.
      const document = await this.documentReadiness.assess({
        tenant_id,
        talent_id: talent_record_id,
        requisition_id,
      });
      const decision = evaluateEligibility(inputs, {
        now: new Date(),
        consumed_count: consumedRows[0]?.n ?? 0,
        restriction_active,
        engagement,
        document,
      });
      if (!decision.eligible && decision.deny !== undefined) {
        throw err(decision.deny, `Submittal not eligible: ${decision.deny}`, 409, {
          submittal_id,
          requisition_id,
        });
      }

      // 4b — CSP PR-3: Client Submittal Policy (the configurable per-client layer).
      // Runs AFTER the existing hard/eligibility gates and BEFORE slot consumption, so
      // a policy denial consumes NO slot. The command SUPPLIES the facts; the pure
      // generic engine decides. resolveEffective is fail-closed (FLOOR); a null result
      // (no published client-submittal policy) is a no-op (an ungoverned tenant).
      const clientPolicy = await this.clientSubmittalPolicy.resolveEffective(tenant_id, {
        company_id,
        requisition_id,
      });
      if (clientPolicy !== null) {
        const workAuthRows = await tx.$queryRawUnsafe<Array<{ work_authorization: string | null }>>(
          `SELECT "work_authorization" FROM "talent_record"."TalentRecord"
            WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
          talent_record_id,
          tenant_id,
        );
        const facts = {
          resume_selected: resume_edition_id !== undefined,
          engagement_satisfied: engagement.satisfied,
          rtr_present: document.satisfied,
          work_authorization_present: (workAuthRows[0]?.work_authorization ?? null) !== null,
          bill_rate_present,
        };
        const policyDecision = this.clientSubmittalPolicy.decide(tenant_id, clientPolicy, facts, requestId);
        const overridden =
          policyDecision.decision === 'REQUIRES_OVERRIDE' &&
          policyDecision.required_capabilities.length > 0 &&
          (input.submittal_actor_can_override ?? false) &&
          (input.submittal_override_reason ?? null) !== null;
        const proceed =
          policyDecision.decision === 'ALLOW' || policyDecision.decision === 'ALLOW_WITH_AUDIT' || overridden;
        if (!proceed) {
          throw err(policyDecision.reason_code, `Client submittal policy: ${policyDecision.reason_code}`, 409, {
            submittal_id,
            requisition_id,
            required_capabilities: policyDecision.required_capabilities,
          });
        }
        // §D12 provenance (in-tx): composite layer identity is the deterministic
        // policy_version; PII-free facts ride `derived`; an override records its
        // reason + capabilities. Written iff the submit commits.
        await insertPolicyDecisionRecordInTx(tx as never, {
          tenant_id,
          decision: policyDecision.decision,
          policy_version: clientPolicy.composite_version,
          rule_id: policyDecision.provenance.map((p) => p.rule_id).join(',') || '__default__',
          reason_code: policyDecision.reason_code,
          resource: CLIENT_SUBMITTAL_RESOURCE,
          action: CLIENT_SUBMITTAL_ACTION,
          inputs: {
            resource: CLIENT_SUBMITTAL_RESOURCE,
            action: CLIENT_SUBMITTAL_ACTION,
            declared: {},
            derived: { ...facts },
            capabilities: {},
            ...(overridden
              ? {
                  override: {
                    reason_code: input.submittal_override_reason ?? null,
                    capabilities: policyDecision.required_capabilities,
                  },
                }
              : {}),
          },
          actor_id: input.actor_id,
          origin: 'ui',
          correlation_id: requestId,
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

      // SW-2 (R4-B) — validate the ACTUAL delivery channel (when provided) against the
      // requisition's SubmittalAuthority EXPECTATION. V1 has no outbound connector, so
      // `aramo_connector` is refused; CLIENT_VMS expects `manual_vms`; CLIENT_MANUAL /
      // ARAMO accept any manual channel (manual recording is the V1 reality). Channel
      // is OPTIONAL (legacy callers omit it); only a PROVIDED channel is validated.
      const deliveryChannel = input.delivery_channel ?? null;
      if (deliveryChannel !== null) {
        const invalid = (reason: string, message: string) =>
          err('SUBMITTAL_DELIVERY_CHANNEL_INVALID', message, 422, {
            submittal_id,
            delivery_channel: deliveryChannel,
            submittal_authority: inputs.submittal_authority,
            reason,
          });
        if (!ALL_DELIVERY_CHANNELS.has(deliveryChannel)) {
          throw invalid('unknown_value', `Unknown delivery_channel: ${deliveryChannel}`);
        }
        if (deliveryChannel === 'aramo_connector') {
          throw invalid(
            'not_executable',
            'aramo_connector is not executable in V1 (no outbound connector); record a manual channel',
          );
        }
        if (inputs.submittal_authority === 'CLIENT_VMS' && deliveryChannel !== 'manual_vms') {
          throw invalid(
            'authority_mismatch',
            'This requisition expects CLIENT_VMS submittal; delivery_channel must be manual_vms',
          );
        }
      }

      // 6 — authoritative submittal write: submitted_to_client + confirmed_at + the
      // FROZEN resume-edition snapshot (TI-1D-D) + SW-2 immutable submittal provenance
      // (who/when/how + frozen client-facing rate + external ref/time) + event + outbox
      // + usage. The provenance columns are pinned ONCE here and frozen by the trigger.
      await tx.$executeRawUnsafe(
        `UPDATE "submittal"."TalentSubmittalRecord"
            SET "state" = 'submitted_to_client',
                "confirmed_at" = NOW(),
                "submitted_at" = NOW(),
                "submitted_by_actor_id" = $2::uuid,
                "resume_edition_id" = $3::uuid,
                "delivery_channel" = $4::"submittal"."SubmittalDeliveryChannel",
                "submitted_bill_rate" = $5::numeric,
                "submitted_rate_currency" = $6,
                "submitted_rate_period" = $7,
                "external_reference" = $8,
                "external_submitted_at" = $9::timestamptz
          WHERE "id" = $1::uuid AND "tenant_id" = $10::uuid`,
        submittal_id,
        input.actor_id,
        resume_edition_id,
        deliveryChannel,
        bill_rate_present ? bill_rate_amount : null,
        bill_rate_present ? bill_rate_currency : null,
        bill_rate_present ? bill_rate_period : null,
        input.external_reference ?? null,
        input.external_submitted_at ?? null,
        tenant_id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "submittal"."TalentSubmittalEvent"
           ("id","tenant_id","submittal_id","event_type","event_payload","created_at")
         VALUES ($1::uuid,$2::uuid,$3::uuid,'state_transition',$4::jsonb,NOW())`,
        input.event_id,
        tenant_id,
        submittal_id,
        JSON.stringify({ from_state: submittal.state, to_state: 'submitted_to_client', resume_edition_id }),
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
          to_state: 'submitted_to_client',
          transition_event_id: input.event_id,
        }),
      );
      await recordUsage(tx, { tenant_id, event_type: 'submittal.state_transition' });

      // Lane 2 / L2-E (SB-5 / D-4) — submit-to-ats does NOT write Pipeline. The
      // authoritative fact is `Submittal.submitted_to_client` + its immutable
      // state_transition event (written above); the retired Pipeline mirror is gone.
      // The episode stays LIVE (D-2) at its recruiter stage; the submit-to-client
      // signal is derived from the Submittal event history by all readers.

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
        state: 'submitted_to_client',
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
