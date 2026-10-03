import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { canTransitionSubmittal } from '@aramo/submittal';
import { isLiveStatus, type PipelineStatus } from '@aramo/pipeline';
import {
  evaluateSubmittalReadiness,
  pipelineLinkVerdict,
  type ClientPolicyReadinessVerdict,
  type SubmittalEngagementApplicability,
  type SubmittalPolicyInputs,
} from '@aramo/submittal-eligibility';
import {
  legalNextClientSelectionStates,
  type ClientSelectionState,
} from '@aramo/client-selection';
import { ClientSubmittalPolicyService } from '@aramo/client-submittal-policy';

import { EngagementGateService } from '../engagement/engagement-gate.service.js';
import { DocumentReadinessGate } from '../rtr/document-readiness.gate.js';

import type { SubmittalWorkspaceView, WorkspaceCommercialSection } from './submittal-workspace.view.js';

// SW-4 — the backend Submittal Workspace READ composition. apps/api is the only
// layer that may know all owners (the talent-360 / my-desk precedent). It composes
// existing authoritative sources ONLY — no new authority, no persistence, no rule
// copy — into one tenant-safe, UI-ready sectioned view. Cross-schema reads run as
// tenant-scoped parameterized raw SQL on ONE connection (the submit-talent pattern);
// the read-only engagement/document/client-policy seams are reused as-is; readiness
// is the SW-3 evaluateSubmittalReadiness authority (no second shape). Financial facts
// are gated on the caller's compensation scope (field-level authorization).

const COMPENSATION_BILL_SCOPE = 'compensation:view:bill';

interface Db {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface SubmittalWorkspaceContext {
  readonly tenant_id: string;
  readonly visible_requisition_ids: ReadonlySet<string> | null;
  readonly scopes: ReadonlySet<string>;
  /**
   * SW-5/D-6 — whether the caller holds the authority the submit command enforces
   * (`submittal:approve` + recruiter consumer). Resolved in the controller from the
   * principal; the service folds it into `actions.can_submit_to_client` so that flag
   * is the single server-owned CTA authority (readiness AND authority).
   */
  readonly submit_authority: boolean;
  readonly request_id: string;
}

interface SubmittalRow {
  id: string;
  talent_id: string;
  job_id: string;
  state: string;
  created_by: string | null;
  created_at: Date | null;
  confirmed_at: Date | null;
  revoked_at: Date | null;
  pipeline_id: string | null;
  resume_edition_id: string | null;
  submitted_at: Date | null;
  submitted_by_actor_id: string | null;
  delivery_channel: string | null;
  submitted_bill_rate: string | null;
  submitted_rate_currency: string | null;
  submitted_rate_period: string | null;
  external_reference: string | null;
  external_submitted_at: Date | null;
}

const iso = (d: Date | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

@Injectable()
export class SubmittalWorkspaceService {
  constructor(
    @Inject('SubmittalWorkspaceDb') private readonly db: Db,
    private readonly engagementGate: EngagementGateService,
    private readonly documentReadiness: DocumentReadinessGate,
    private readonly clientSubmittalPolicy: ClientSubmittalPolicyService,
  ) {}

  async compose(ctx: SubmittalWorkspaceContext, submittal_id: string): Promise<SubmittalWorkspaceView> {
    const { tenant_id } = ctx;
    const notFound = () =>
      new AramoError('NOT_FOUND', 'Submittal not found', 404, {
        requestId: ctx.request_id,
        details: { submittal_id },
      });

    // 1 — submittal (tenant-scoped; includes the SW-2 provenance columns not in the
    // lib view). Absent ⇒ 404. Visibility conceal: the submittal's requisition must be
    // in the caller's visible set (null = see-all), else 404 (never a cross-set leak).
    const subs = await this.db.$queryRawUnsafe<SubmittalRow[]>(
      `SELECT "id","talent_id","job_id","state","created_by","created_at","confirmed_at","revoked_at",
              "pipeline_id","resume_edition_id","submitted_at","submitted_by_actor_id","delivery_channel",
              "submitted_bill_rate"::text AS "submitted_bill_rate","submitted_rate_currency","submitted_rate_period",
              "external_reference","external_submitted_at"
         FROM "submittal"."TalentSubmittalRecord"
        WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
      submittal_id,
      tenant_id,
    );
    const submittal = subs[0];
    if (submittal === undefined) throw notFound();
    if (ctx.visible_requisition_ids !== null && !ctx.visible_requisition_ids.has(submittal.job_id)) {
      throw notFound();
    }
    const requisition_id = submittal.job_id;
    const talent_id = submittal.talent_id;

    // 2 — requisition (tenant-scoped) + talent + company + linked pipeline + working résumé,
    // all tenant-scoped raw reads on the same connection. Absent rows ⇒ explicit null.
    const reqs = await this.db.$queryRawUnsafe<
      Array<{
        title: string | null;
        status: string | null;
        company_id: string | null;
        recruiter_id: string | null;
        owner_id: string | null;
        bill_rate_amount: string | null;
        bill_rate_currency: string | null;
        bill_rate_period: string | null;
      }>
    >(
      `SELECT "title","status","company_id","recruiter_id","owner_id",
              "bill_rate_amount"::text AS "bill_rate_amount","bill_rate_currency","bill_rate_period"
         FROM "requisition"."Requisition" WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
      requisition_id,
      tenant_id,
    );
    const req = reqs[0] ?? null;
    const company_id = req?.company_id ?? null;

    const talents = await this.db.$queryRawUnsafe<
      Array<{ first_name: string | null; last_name: string | null; title: string | null; city: string | null; state: string | null; work_authorization: string | null; owner_id: string | null }>
    >(
      `SELECT "first_name","last_name","title","city","state","work_authorization","owner_id"
         FROM "talent_record"."TalentRecord" WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
      talent_id,
      tenant_id,
    );
    const talent = talents[0] ?? null;
    const joinNonEmpty = (parts: Array<string | null>, sep: string): string | null => {
      const v = parts.filter((p) => p != null && p !== '').join(sep);
      return v === '' ? null : v;
    };
    const talentName = talent ? joinNonEmpty([talent.first_name, talent.last_name], ' ') : null;
    const talentLocation = talent ? joinNonEmpty([talent.city, talent.state], ', ') : null;

    let companyName: string | null = null;
    if (company_id !== null) {
      const companies = await this.db.$queryRawUnsafe<Array<{ name: string | null }>>(
        `SELECT "name" FROM "company"."Company" WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
        company_id,
        tenant_id,
      );
      companyName = companies[0]?.name ?? null;
    }

    let pipelineRow: { id: string; status: string; requisition_id: string; talent_record_id: string; tenant_id: string } | undefined;
    if (submittal.pipeline_id !== null) {
      const pipes = await this.db.$queryRawUnsafe<Array<typeof pipelineRow & object>>(
        `SELECT "id","status","requisition_id","talent_record_id","tenant_id"
           FROM "pipeline"."Pipeline" WHERE "id" = $1::uuid AND "tenant_id" = $2::uuid`,
        submittal.pipeline_id,
        tenant_id,
      );
      pipelineRow = pipes[0];
    }
    const episodeLive = pipelineRow !== undefined && isLiveStatus(pipelineRow.status as PipelineStatus);

    const resumeRows = await this.db.$queryRawUnsafe<Array<{ resume_edition_id: string }>>(
      `SELECT "resume_edition_id" FROM "pipeline"."TalentRequisitionResume"
        WHERE "tenant_id" = $1::uuid AND "talent_record_id" = $2::uuid AND "requisition_id" = $3::uuid
        ORDER BY "selected_at" DESC LIMIT 1`,
      tenant_id,
      talent_id,
      requisition_id,
    );
    const resume_selected = resumeRows.length > 0;

    // 3 — readiness inputs (policy window / consumed count / restriction), raw + tenant-scoped,
    // mirroring the submit path's resolution but READ-ONLY (no slot consume, no provenance write).
    const policyInputs = await this.readPolicyInputs(tenant_id, requisition_id);
    const consumedRows = await this.db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS "n" FROM "submittal_policy"."SubmittalConsumption"
        WHERE "tenant_id" = $1::uuid AND "requisition_id" = $2::uuid`,
      tenant_id,
      requisition_id,
    );
    const restriction_active = await this.isRestrictedAtClient(tenant_id, company_id, talent_id);

    // 4 — read-only domain verdicts (engagement, RTR, client policy).
    const engagementApplicability: SubmittalEngagementApplicability = await this.engagementGate.resolveApplicability({
      tenant_id,
      company_id,
      requisition_id,
    });
    const engagementReadiness = await this.engagementGate.readReadiness({
      tenant_id,
      talent_id,
      requisition_id,
      company_id,
    });
    const rtrVerdict = await this.documentReadiness.assess({ tenant_id, talent_id, requisition_id });

    const clientPolicy = await this.clientSubmittalPolicy.resolveEffective(tenant_id, {
      company_id,
      requisition_id,
    });
    let clientPolicyVerdict: ClientPolicyReadinessVerdict | null = null;
    if (clientPolicy !== null) {
      const facts = {
        resume_selected,
        engagement_satisfied: engagementReadiness.satisfied,
        rtr_present: rtrVerdict.satisfied,
        work_authorization_present: (talent?.work_authorization ?? null) !== null,
        bill_rate_present: (req?.bill_rate_amount ?? null) !== null,
      };
      const decision = this.clientSubmittalPolicy.decide(tenant_id, clientPolicy, facts, ctx.request_id);
      const proceed = decision.decision === 'ALLOW' || decision.decision === 'ALLOW_WITH_AUDIT';
      clientPolicyVerdict = {
        applicable: true,
        satisfied: proceed,
        reason_code: proceed ? null : decision.reason_code,
        overridable: decision.decision === 'REQUIRES_OVERRIDE' && decision.required_capabilities.length > 0,
      };
    }

    // 5 — the ONE readiness authority (SW-3), reused exactly.
    const readiness = evaluateSubmittalReadiness({
      submittal_state: submittal.state,
      submittal_state_can_send: canTransitionSubmittal(submittal.state as never, 'submitted_to_client'),
      pipeline: pipelineLinkVerdict({
        pipeline_id: submittal.pipeline_id,
        episode:
          pipelineRow !== undefined
            ? { tenant_id: pipelineRow.tenant_id, requisition_id: pipelineRow.requisition_id, talent_record_id: pipelineRow.talent_record_id }
            : null,
        episode_is_live: episodeLive,
        expected: { tenant_id, requisition_id, talent_id },
      }),
      requisition_status: req?.status ?? null,
      resume_selected,
      policy: { inputs: policyInputs, consumed_count: consumedRows[0]?.n ?? 0 },
      rtr_verdict: rtrVerdict,
      restriction_active,
      engagement: engagementApplicability,
      client_policy: clientPolicyVerdict,
      now: new Date(),
    });

    // 6 — client selection + latest interview + feedback history (composed from
    // ClientSelectionProcess / InterviewSession / ClientSelectionEvent; no new model).
    const csRows = await this.db.$queryRawUnsafe<Array<{ id: string; state: string }>>(
      `SELECT "id","state" FROM "client_selection"."ClientSelectionProcess"
        WHERE "submittal_id" = $1::uuid AND "tenant_id" = $2::uuid`,
      submittal_id,
      tenant_id,
    );
    const cs = csRows[0] ?? null;
    let latestInterview: SubmittalWorkspaceView['client_selection']['latest_interview'] = null;
    let feedback: SubmittalWorkspaceView['client_selection']['feedback'] = [];
    if (cs !== null) {
      const iv = await this.db.$queryRawUnsafe<Array<{ round: number; state: string; scheduled_at: Date | null }>>(
        `SELECT "round","state","scheduled_at" FROM "client_selection"."InterviewSession"
          WHERE "client_selection_process_id" = $1::uuid AND "tenant_id" = $2::uuid
          ORDER BY "round" DESC LIMIT 1`,
        cs.id,
        tenant_id,
      );
      const ivRow = iv[0];
      if (ivRow !== undefined) {
        latestInterview = { round: ivRow.round, state: ivRow.state, scheduled_at: iso(ivRow.scheduled_at) };
      }
      const events = await this.db.$queryRawUnsafe<Array<{ event_payload: Record<string, unknown>; created_at: Date }>>(
        `SELECT "event_payload","created_at" FROM "client_selection"."ClientSelectionEvent"
          WHERE "selection_id" = $1::uuid AND "tenant_id" = $2::uuid
          ORDER BY "created_at" DESC`,
        cs.id,
        tenant_id,
      );
      feedback = events.map((e) => ({
        at: iso(e.created_at) ?? '',
        to_state: typeof e.event_payload?.['to_state'] === 'string' ? (e.event_payload['to_state'] as string) : null,
        reason_code: typeof e.event_payload?.['reason_code'] === 'string' ? (e.event_payload['reason_code'] as string) : null,
        note: typeof e.event_payload?.['note'] === 'string' ? (e.event_payload['note'] as string) : null,
      }));
    }

    // 7 — field-level commercial authorization. Present ONLY when the caller holds the
    // compensation bill-rate scope (gates BOTH the live requisition rate AND the frozen
    // submitted snapshot — whose field names are outside the global mask catalog).
    const commercial: WorkspaceCommercialSection | null = ctx.scopes.has(COMPENSATION_BILL_SCOPE)
      ? {
          live_bill_rate_amount: req?.bill_rate_amount ?? null,
          live_bill_rate_currency: req?.bill_rate_currency ?? null,
          live_bill_rate_period: req?.bill_rate_period ?? null,
          submitted_bill_rate: submittal.submitted_bill_rate,
          submitted_rate_currency: submittal.submitted_rate_currency,
          submitted_rate_period: submittal.submitted_rate_period,
        }
      : null;

    const csNextStates =
      cs !== null ? legalNextClientSelectionStates(cs.state as ClientSelectionState) : [];

    return {
      identity: {
        submittal_id: submittal.id,
        talent: { id: talent_id, name: talentName },
        requisition: { id: requisition_id, title: req?.title ?? null },
        company: company_id !== null ? { id: company_id, name: companyName } : null,
      },
      context: {
        recruiter: req?.recruiter_id != null ? { id: req.recruiter_id, name: null } : null,
        owner: req?.owner_id != null ? { id: req.owner_id, name: null } : talent?.owner_id != null ? { id: talent.owner_id, name: null } : null,
        talent_location: talentLocation,
        talent_title: talent?.title ?? null,
        work_authorization: talent?.work_authorization ?? null,
      },
      pipeline: {
        linked_episode_id: pipelineRow?.id ?? null,
        current_stage: pipelineRow?.status ?? null,
        is_live: episodeLive,
      },
      submittal: {
        state: submittal.state,
        created_at: iso(submittal.created_at),
        created_by: submittal.created_by,
        confirmed_at: iso(submittal.confirmed_at),
        revoked_at: iso(submittal.revoked_at),
        resume_edition_id: submittal.resume_edition_id,
      },
      readiness,
      documents: {
        rtr_satisfied: rtrVerdict.satisfied,
        rtr_deny: rtrVerdict.deny,
        resume_selected,
      },
      engagement: {
        governed: engagementReadiness.governed,
        policy_present: engagementReadiness.policy_present,
        satisfied: engagementReadiness.satisfied,
        override_available: engagementReadiness.override_available,
        unavailable: engagementReadiness.unavailable,
      },
      commercial,
      delivery: {
        delivery_channel: submittal.delivery_channel,
        external_reference: submittal.external_reference,
        external_submitted_at: iso(submittal.external_submitted_at),
        submitted_at: iso(submittal.submitted_at),
        submitted_by_actor_id: submittal.submitted_by_actor_id,
      },
      client_selection: {
        present: cs !== null,
        state: cs?.state ?? null,
        latest_interview: latestInterview,
        feedback,
      },
      actions: {
        // SW-5/D-6 — the final, server-owned CTA authority: readiness READY AND the
        // caller holds submit authority. The FE consumes this single flag for the
        // primary CTA and never recombines readiness with authority itself.
        can_submit_to_client: readiness.status === 'READY' && ctx.submit_authority,
        submit_authority: ctx.submit_authority,
        can_revoke: canTransitionSubmittal(submittal.state as never, 'revoked'),
        client_selection_next_states: csNextStates,
      },
    };
  }

  private async readPolicyInputs(tenant_id: string, requisition_id: string): Promise<SubmittalPolicyInputs> {
    const rows = await this.db.$queryRawUnsafe<
      Array<{ submittal_deadline: Date | null; submittal_limit: number | null; manual_override: string | null; submittal_authority: string }>
    >(
      `SELECT "submittal_deadline","submittal_limit","manual_override","submittal_authority"
         FROM "submittal_policy"."RequisitionSubmittalPolicy"
        WHERE "tenant_id" = $1::uuid AND "requisition_id" = $2::uuid`,
      tenant_id,
      requisition_id,
    );
    const row = rows[0];
    if (row === undefined) {
      return { submittal_deadline: null, submittal_limit: null, manual_override: null, submittal_authority: 'ARAMO' };
    }
    return {
      submittal_deadline: row.submittal_deadline,
      submittal_limit: row.submittal_limit,
      manual_override: row.manual_override as never,
      submittal_authority: row.submittal_authority as never,
    };
  }

  private async isRestrictedAtClient(tenant_id: string, company_id: string | null, talent_record_id: string): Promise<boolean> {
    if (company_id === null) return false;
    const restr = await this.db.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS "one" FROM "client_talent_restriction"."ClientTalentRestriction"
        WHERE "tenant_id" = $1::uuid AND "client_company_id" = $2::uuid AND "talent_record_id" = $3::uuid
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
