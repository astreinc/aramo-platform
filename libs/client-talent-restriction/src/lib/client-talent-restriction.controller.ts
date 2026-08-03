import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, type AramoLogger, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';

import type { CreateRestrictionRequestDto } from './dto/create-restriction-request.dto.js';
import type { CloseRestrictionRequestDto } from './dto/close-restriction-request.dto.js';
import type {
  CloseRestrictionResponseDto,
  CreateRestrictionResponseDto,
  CurrentRestrictionsResponseDto,
  RestrictionHistoryResponseDto,
} from './dto/client-talent-restriction.view.js';
import {
  isAssertedByType,
  isCloseReasonCode,
  isGovernedSourceReference,
  isRestrictionType,
  isSourceSystem,
} from './client-talent-restriction-vocab.js';
import { ClientTalentRestrictionRepository } from './client-talent-restriction.repository.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Track 3 / E7 — ClientTalentRestriction controller.
//
// ROUTE SHAPE IS THE ENFORCEMENT (E7 §2b). There is NO flat collection
// route. Every operation is nested under a specific client AND a specific
// talent, so a read STRUCTURALLY requires tenant + client + talent — R2/R3
// are enforced by the URL, not by convention. The prohibited shapes
// (`GET /v1/talent/{id}/restrictions`, `GET /v1/client-talent-restrictions`,
// `GET /v1/restrictions?talent_id=`) simply do not exist on this
// controller, and the repository exposes no method that could back them.
//
// Auth posture: JwtAuthGuard (AuthN) + a per-handler recruiter check.
// Deliberately NO new authz scope is introduced (that would ripple into
// the seed scope catalog, which this directive does not authorize).
@Controller('v1/clients/:client_company_id/talent/:talent_record_id/restrictions')
@UseGuards(JwtAuthGuard)
export class ClientTalentRestrictionController {
  constructor(
    private readonly repository: ClientTalentRestrictionRepository,
    @Inject('ClientTalentRestrictionControllerLogger')
    private readonly logger: AramoLogger,
  ) {
    void this.logger;
  }

  // POST /v1/clients/{client_company_id}/talent/{talent_record_id}/restrictions
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async record(
    @Param('client_company_id') client_company_id: string,
    @Param('talent_record_id') talent_record_id: string,
    @Body() body: CreateRestrictionRequestDto,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CreateRestrictionResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    this.assertPathUuid(client_company_id, 'client_company_id', requestId);
    this.assertPathUuid(talent_record_id, 'talent_record_id', requestId);

    // R1 — asserted_by_type, source_system, source_reference all required
    // and validly established. All creation-validation failures raise the
    // single RESTRICTION_INVALID (422) with details.reason (PO ruling —
    // per-field codes rejected: four parity surfaces each for no caller gain).
    if (!isAssertedByType(body.asserted_by_type) || !isSourceSystem(body.source_system)
        || typeof body.source_reference !== 'string' || body.source_reference.trim().length === 0) {
      throw this.invalid(requestId, 'asserter_required', {
        asserted_by_type_present: isAssertedByType(body.asserted_by_type),
        source_system_present: isSourceSystem(body.source_system),
        source_reference_present:
          typeof body.source_reference === 'string' && body.source_reference.trim().length > 0,
      });
    }
    // source_reference must be governed (never free narrative text).
    if (!isGovernedSourceReference(body.source_reference)) {
      throw this.invalid(requestId, 'source_reference_not_governed', { field: 'source_reference' });
    }
    // restriction_type must be a registered ADR-0027 value (R10 tripwire).
    if (!isRestrictionType(body.restriction_type)) {
      throw this.invalid(requestId, 'restriction_type_unregistered', {
        restriction_type: String(body.restriction_type),
      });
    }
    // raw_source_value is OPTIONAL (PO ruling) — no presence check.
    this.assertNonEmptyString(body.reason_code, 'reason_code', requestId);

    const effective_from = this.parseTimestamp(body.effective_from, 'effective_from', requestId);
    let scheduled_end_at: Date | null = null;
    if (body.scheduled_end_at !== undefined && body.scheduled_end_at !== null) {
      scheduled_end_at = this.parseTimestamp(body.scheduled_end_at, 'scheduled_end_at', requestId);
      // Option B — a scheduled expiry must be strictly after effective_from.
      if (scheduled_end_at.getTime() <= effective_from.getTime()) {
        throw this.invalid(requestId, 'scheduled_end_at_not_after_effective_from', {});
      }
    }

    const recorded_by = this.assertSubIsUuid(authContext, requestId);

    const restriction = await this.repository.recordRestriction(
      {
        tenant_id: authContext.tenant_id,
        client_company_id,
        talent_record_id,
        restriction_type: body.restriction_type,
        asserted_by_type: body.asserted_by_type,
        asserting_organization_reference: body.asserting_organization_reference ?? null,
        asserting_contact_reference: body.asserting_contact_reference ?? null,
        source_system: body.source_system,
        source_reference: body.source_reference.trim(),
        raw_source_value: body.raw_source_value ?? null,
        reason_code: body.reason_code,
        recorded_by,
        effective_from,
        scheduled_end_at,
      },
      requestId,
    );
    return { restriction };
  }

  // GET .../restrictions/current — "is this person restricted at THIS client, now?"
  @Get('current')
  @HttpCode(HttpStatus.OK)
  async current(
    @Param('client_company_id') client_company_id: string,
    @Param('talent_record_id') talent_record_id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CurrentRestrictionsResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    this.assertPathUuid(client_company_id, 'client_company_id', requestId);
    this.assertPathUuid(talent_record_id, 'talent_record_id', requestId);

    const active_restrictions = await this.repository.findCurrentForClientTalent({
      tenant_id: authContext.tenant_id,
      client_company_id,
      talent_record_id,
    });
    // "Currently restricted" = presence of ANY applicable active restriction
    // in this client-talent context. NOT a cross-source/cross-client count.
    return { restricted: active_restrictions.length > 0, active_restrictions };
  }

  // GET .../restrictions/history — source-attributed records for THIS client-talent context.
  @Get('history')
  @HttpCode(HttpStatus.OK)
  async history(
    @Param('client_company_id') client_company_id: string,
    @Param('talent_record_id') talent_record_id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RestrictionHistoryResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    this.assertPathUuid(client_company_id, 'client_company_id', requestId);
    this.assertPathUuid(talent_record_id, 'talent_record_id', requestId);

    const restrictions = await this.repository.findHistoryForClientTalent({
      tenant_id: authContext.tenant_id,
      client_company_id,
      talent_record_id,
    });
    return { restrictions };
  }

  // POST .../restrictions/{restriction_id}/close — the explicit close.
  @Post(':restriction_id/close')
  @HttpCode(HttpStatus.OK)
  async close(
    @Param('client_company_id') client_company_id: string,
    @Param('talent_record_id') talent_record_id: string,
    @Param('restriction_id') restriction_id: string,
    @Body() body: CloseRestrictionRequestDto,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CloseRestrictionResponseDto> {
    this.assertConsumerIsRecruiter(authContext, requestId);
    this.assertPathUuid(client_company_id, 'client_company_id', requestId);
    this.assertPathUuid(talent_record_id, 'talent_record_id', requestId);
    this.assertPathUuid(restriction_id, 'restriction_id', requestId);

    const effective_to = this.parseTimestamp(body.effective_to, 'effective_to', requestId);
    if (!isCloseReasonCode(body.close_reason_code)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'close_reason_code is not a registered close reason',
        400,
        { requestId, details: { invalid_field: 'close_reason_code' } },
      );
    }
    if (!isSourceSystem(body.close_source_system)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'close_source_system is not a registered source system',
        400,
        { requestId, details: { invalid_field: 'close_source_system' } },
      );
    }
    if (!isGovernedSourceReference(body.close_source_reference)) {
      throw this.invalid(requestId, 'close_source_reference_not_governed', {
        field: 'close_source_reference',
      });
    }

    const closed_by = this.assertSubIsUuid(authContext, requestId);

    const restriction = await this.repository.closeRestriction(
      {
        tenant_id: authContext.tenant_id,
        client_company_id,
        talent_record_id,
        restriction_id,
        effective_to,
        closed_by,
        close_reason_code: body.close_reason_code,
        close_source_system: body.close_source_system,
        close_source_reference: body.close_source_reference.trim(),
      },
      requestId,
    );
    return { restriction };
  }

  // ---- validation helpers ----

  private assertConsumerIsRecruiter(authContext: AuthContextType, requestId: string): void {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'client-talent-restriction endpoints are recruiter-only',
        403,
        { requestId, details: { consumer_type: authContext.consumer_type } },
      );
    }
  }

  private assertPathUuid(value: string, field: string, requestId: string): void {
    if (!UUID_REGEX.test(value)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `${field} path parameter must be a UUID`,
        400,
        { requestId, details: { invalid_field: field } },
      );
    }
  }

  private assertNonEmptyString(value: unknown, field: string, requestId: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `${field} is required`,
        400,
        { requestId, details: { missing_field: field } },
      );
    }
  }

  private assertSubIsUuid(authContext: AuthContextType, requestId: string): string {
    if (!UUID_REGEX.test(authContext.sub)) {
      throw new AramoError(
        'INVALID_REQUEST',
        'auth context sub claim must be a UUID',
        400,
        { requestId, details: { invalid_field: 'sub' } },
      );
    }
    return authContext.sub;
  }

  private parseTimestamp(value: unknown, field: string, requestId: string): Date {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `${field} is required (ISO 8601 timestamp)`,
        400,
        { requestId, details: { missing_field: field } },
      );
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `${field} must be a valid ISO 8601 timestamp`,
        400,
        { requestId, details: { invalid_field: field } },
      );
    }
    return d;
  }

  // Single creation/close validation refusal (PO ruling). details.reason
  // distinguishes the case; a governed source_reference example is included
  // for the reference-format cases.
  private invalid(
    requestId: string,
    reason: string,
    details: Record<string, unknown>,
  ): AramoError {
    return new AramoError(
      'RESTRICTION_INVALID',
      `ClientTalentRestriction request invalid: ${reason}`,
      422,
      { requestId, details: { reason, ...details } },
    );
  }
}
