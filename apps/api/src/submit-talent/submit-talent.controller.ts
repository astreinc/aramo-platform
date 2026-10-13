import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, hashCanonicalizedBody, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { IdempotencyService } from '@aramo/consent';
import {
  SubmittalRepository,
  TalentSubmittalEventRepository,
  type TalentSubmittalRecordView,
  type TalentSubmittalEventView,
} from '@aramo/submittal';

import { SubmitTalentToClientService } from './submit-talent.service.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * COMM PART A — parse an optional engagement-policy override from the submit body.
 * Shape: `{ engagement_override: { reason: string } }`. The reason's validity
 * (non-empty, bounded) is enforced authoritatively in the Engagement domain; here
 * we only extract a well-typed reason string (or undefined = no override).
 */
function parseEngagementOverride(body: Record<string, unknown>): { reason: string } | undefined {
  const raw = body['engagement_override'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const reason = (raw as Record<string, unknown>)['reason'];
  if (typeof reason !== 'string') return undefined;
  return { reason };
}

// Lane L8-B1 (v1.2 + Amendment A2) — the re-pointed authoritative client-submittal
// route. The ONLY way a Talent is submitted to a client (the submittal is the
// authoritative fact; the Pipeline is not written). A thin adapter: it preserves the existing public
// contract (Idempotency-Key replay/conflict + the `{ submittal }` response envelope)
// and delegates the whole atomic write to SubmitTalentToClientService. The legacy
// submittal-repository submit-to-ats write path is removed (no parallel path); a
// pipeline-less submittal is refused (SUBMITTAL_PIPELINE_LINK_INVALID, R-REFUSAL).
export interface SubmitToAtsResponse {
  readonly submittal: TalentSubmittalRecordView;
  readonly event: TalentSubmittalEventView;
}

// INC-1b (TIP-E2E) — tenant-capability parity: EntitlementGuard +
// @RequireCapability('ats') added (was JwtAuthGuard+RolesGuard only). Applies to
// submit-to-client + the submit-to-ats alias. Server-resolved site + requisition
// actor-visibility on the send are the follow-on INC-1b step.
@Controller('v1/submittals')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class SubmitTalentController {
  constructor(
    private readonly command: SubmitTalentToClientService,
    private readonly submittalRepository: SubmittalRepository,
    private readonly eventRepository: TalentSubmittalEventRepository,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  // SW-2 (R2-A) — the CANONICAL client-submittal command. `submitted_to_client` is
  // the authoritative business fact; delivery_channel / external reference / actor /
  // timestamp are provenance of that fact (captured here, frozen at the send).
  @Post(':submittal_id/submit-to-client')
  @RequireScopes('submittal:approve')
  @HttpCode(HttpStatus.OK)
  async submitToClient(
    @Param('submittal_id') submittal_id: string,
    @Body() body: Record<string, unknown>,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<SubmitToAtsResponse> {
    return this.submitImpl(submittal_id, body, idempotencyKey, authContext, requestId, req);
  }

  // SW-2 (R2-A) — COMPATIBILITY ALIAS. The legacy /submit-to-ats path delegates to
  // the SAME implementation (no duplicated logic) so existing clients keep working
  // during the transition. Deprecated; prefer /submit-to-client.
  @Post(':submittal_id/submit-to-ats')
  @RequireScopes('submittal:approve')
  @HttpCode(HttpStatus.OK)
  async submitToAts(
    @Param('submittal_id') submittal_id: string,
    @Body() body: Record<string, unknown>,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<SubmitToAtsResponse> {
    return this.submitImpl(submittal_id, body, idempotencyKey, authContext, requestId, req);
  }

  private async submitImpl(
    submittal_id: string,
    body: Record<string, unknown>,
    idempotencyKey: string | undefined,
    authContext: AuthContextType,
    requestId: string,
    req: Request,
  ): Promise<SubmitToAtsResponse> {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'submit-to-ats endpoint is recruiter-only',
        403,
        { requestId, details: { consumer_type: authContext.consumer_type } },
      );
    }
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);

    // Idempotency-Key replay/conflict (preserved from the legacy route).
    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as SubmitToAtsResponse;
    }

    // COMM PART A — an optional engagement-policy override. Authority is
    // scope-based (`engagement:policy:override`), never a role name; a reason is
    // required (validated in the domain). The override is inert unless the effective
    // policy is ENFORCING_WITH_OVERRIDE and a required evidence item is missing.
    const engagementOverride = parseEngagementOverride(body);

    // SW-2 (R4-A/R4-B) — submittal delivery provenance from the body. The channel's
    // enum / executability / authority-consistency SEMANTIC validity is enforced
    // authoritatively in the command; here we extract well-typed values and enforce
    // INC-1d PRESENCE below.
    const deliveryChannel = typeof body['delivery_channel'] === 'string' ? body['delivery_channel'] : null;
    const externalReference = typeof body['external_reference'] === 'string' ? body['external_reference'] : null;
    const externalSubmittedAt = typeof body['external_submitted_at'] === 'string' ? body['external_submitted_at'] : null;
    // INC-1d (TIP-E2E) — the mandatory manual-handoff attestation. Only the literal
    // boolean true satisfies it; anything else (absent / false / non-boolean) is
    // not-attested.
    const handoffPerformed = body['handoff_performed'] === true;

    // INC-1d (TIP-E2E) — manual-handoff integrity enforced at the HTTP send boundary,
    // BEFORE the mutation command runs (a non-attested / channel-less send never enters
    // the transaction). This covers BOTH the submit-to-client route AND the submit-to-ats
    // alias — they share submitImpl, so the equivalent mutation enforces the same policy.
    // handoff_performed:true is the recruiter attesting the manual client handoff actually
    // occurred (the platform transmits nothing — an ATTESTED + RECORDED handoff, never an
    // independently-verified client receipt). delivery_channel is REQUIRED (how it
    // happened); its enum/authority validity is checked authoritatively in the command.
    if (!handoffPerformed) {
      throw new AramoError(
        'ATTESTATION_MISSING',
        'A handoff_performed:true attestation is required to record a client handoff',
        422,
        { requestId, details: { missing_field: 'handoff_performed' } },
      );
    }
    if (deliveryChannel === null) {
      throw new AramoError(
        'SUBMITTAL_DELIVERY_CHANNEL_INVALID',
        'delivery_channel is required to record the manual client handoff',
        422,
        { requestId, details: { reason: 'required' } },
      );
    }

    // The single atomic operation: submitted_to_client (authoritative) + serialized
    // slot consumption + provenance, all-or-nothing. L2-E (SB-5) retired the
    // Pipeline mirror — this command does NOT write Pipeline; the episode stays
    // LIVE and readers derive the submit-to-client signal from the event.
    // INC-1b (TIP-E2E) — actor-site + requisition-visibility are enforced INSIDE
    // the command's transaction, BEFORE any state mutation / slot consumption /
    // outbox write, reusing the already-validated submittal->pipeline->requisition
    // chain. Tenant-wide principals carry a null site claim; see_all actors get a
    // null visible-id set (no filter). resolveVisibleRequisitionIds is the global
    // VisibilityInterceptor's authorized read.
    const actor_site_id = authContext.site_id ?? null;
    const visible_requisition_ids = await req.resolveVisibleRequisitionIds!();

    // INC-1c (TIP-E2E) — provisional MANDATORY-RTR interim product policy flag.
    // Default OFF (DEPLOYED-DARK): the fail-closed RTR control inside the command
    // ships inert until Legal/PO activation flips this env, so existing valid flows
    // are unchanged. Build + full test authorized now; activation is separately gated.
    const rtr_disclosure_mandatory =
      process.env['ARAMO_TIP_E2E_RTR_DISCLOSURE_MANDATORY'] === '1';

    const eventId = randomUUID();
    await this.command.submitToClient({
      tenant_id: authContext.tenant_id,
      submittal_id,
      event_id: eventId,
      actor_id: authContext.sub,
      actor_site_id,
      visible_requisition_ids,
      rtr_disclosure_mandatory,
      actor_can_override: authContext.scopes.includes('engagement:policy:override'),
      engagement_override: engagementOverride,
      // CSP PR-3 — the client-submittal-policy override authority is a DISTINCT scope
      // (never a role name); the reason (when present) is shared with the engagement
      // override input and recorded in the decision provenance.
      submittal_actor_can_override: authContext.scopes.includes('client-submittal-policy:override'),
      submittal_override_reason: engagementOverride?.reason ?? null,
      handoff_performed: handoffPerformed,
      delivery_channel: deliveryChannel,
      external_reference: externalReference,
      external_submitted_at: externalSubmittedAt,
      requestId,
    });

    // Preserve the public `{ submittal, event }` envelope (Ruling 14) — the
    // authoritative result is the submittal now in submitted_to_client plus the
    // state_transition event the command wrote (the Pipeline is not written).
    const submittal = await this.submittalRepository.findById({
      tenant_id: authContext.tenant_id,
      id: submittal_id,
    });
    const event = await this.eventRepository.findByTenantAndId({
      tenant_id: authContext.tenant_id,
      id: eventId,
    });
    if (submittal === null || event === null) {
      throw new AramoError('NOT_FOUND', 'TalentSubmittalRecord not found', 404, {
        requestId,
        details: { submittal_id },
      });
    }
    const response: SubmitToAtsResponse = { submittal, event };

    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.OK,
      response_body: response,
    });
    return response;
  }

  private assertIdempotencyKeyRequired(
    idempotencyKey: string | undefined,
    requestId: string,
  ): string {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        400,
        { requestId, details: { missing_field: 'Idempotency-Key' } },
      );
    }
    if (!UUID_REGEX.test(idempotencyKey)) {
      throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key must be a UUID', 400, {
        requestId,
        details: { invalid_field: 'Idempotency-Key' },
      });
    }
    return idempotencyKey;
  }
}
