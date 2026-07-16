import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  ConsentService,
  type ConsentHistoryResponseDto,
  type PortalConsentTextResponseDto,
  type TalentConsentStateResponseDto,
} from '@aramo/consent';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { TenantService } from '@aramo/identity';
import { TalentRecordService } from '@aramo/talent-record';
import {
  TalentTrustService,
  type PortalDisputeRow,
} from '@aramo/talent-trust';

import {
  PortalConsentGrantRequestDto,
  PortalConsentRevokeRequestDto,
  type PortalConsentMutationDto,
} from './dto/portal-consent.dto.js';
import {
  PortalDisputeOpenRequestDto,
  PortalDisputeRespondRequestDto,
  type PortalDisputeDetailDto,
  type PortalDisputeListResponseDto,
  type PortalDisputeMutationDto,
  type PortalVerificationsResponseDto,
} from './dto/portal-dispute.dto.js';
import type { PortalProfileDto } from './dto/portal-profile.dto.js';
import type { PortalRecordsResponseDto } from './dto/portal-records.dto.js';
import { PortalTalentResolverService } from './portal-talent-resolver.service.js';

// Portal P1 PR-2a — Portal Controller (OPEN-4 chain). The placeholder
// `sub`-passthrough is GONE: the portal session's JWT `sub` (= PortalUser.id)
// resolves to the portal user's ATS records ACROSS tenants via
// PortalTalentResolverService (sub → PortalUser → cluster → PERSON_CLUSTER
// holders → survivor subjects → live TalentRecords).
//
// Three reads (the old GET /v1/portal/profile + /consent are REMOVED, not
// aliased — nothing runtime consumed them; the portal-thin pact is repointed
// in-slice):
//   GET /v1/portal/records                 — the portal user's records across
//                                            tenants (engagement surface, P-R5)
//   GET /v1/portal/records/:id/profile     — one record's R10-filtered profile
//   GET /v1/portal/records/:id/consent     — one record's consent state
//
// Auth posture: `sub` derives identity from the JWT (never a path/body param for
// WHO the caller is). Every per-record read validates membership through the
// chain — a record id not reachable is a UNIFORM 404 (oracle-resistant: no
// "exists but not yours"). A portal user with no cluster / no live records is a
// VALID EMPTY state (200 with an empty list), never an error.
//
// R10 refusal enforcement stays structural: this controller emits only
// PortalProfileDto (+ list) + TalentConsentStateResponseDto — all openapi-bound
// with additionalProperties:false, walked by ci/scripts/verify-portal-refusal.ts.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/portal')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('portal')
export class PortalController {
  constructor(
    private readonly resolver: PortalTalentResolverService,
    private readonly talentRecordService: TalentRecordService,
    private readonly consentService: ConsentService,
    // Portal P2 P2b — tenant_name enrichment (scope:ats → scope:shared, legal).
    private readonly tenantService: TenantService,
    // Portal P3a — verification view + dispute intake.
    private readonly trustService: TalentTrustService,
  ) {}

  // Portal P3a — talent-level (NOT per-record) dispute id → wire envelope.
  private toDisputeMutation(row: PortalDisputeRow): PortalDisputeMutationDto {
    return {
      dispute_id: row.id,
      status: row.status,
      opened_at: row.opened_at.toISOString(),
    };
  }

  // Portal P2 P2b — resolve the engagement counterparty's human name. The
  // always-present workspace name (Tenant.name); null (defensive) only if the
  // tenant row vanished. One indexed read; the callers already loop/await
  // per-record service calls, so this adds no new N+1 shape.
  private async resolveTenantName(tenantId: string): Promise<string | null> {
    const tenant = await this.tenantService.getTenantById(tenantId);
    return tenant?.name ?? null;
  }

  // GET /v1/portal/records — the portal user's records across tenants.
  @Get('records')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:profile:read')
  async getRecords(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalRecordsResponseDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const refs = await this.resolver.resolveRecords(sub);
    const records: PortalProfileDto[] = [];
    for (const ref of refs) {
      const projection = await this.talentRecordService.findSelfProfile({
        tenant_id: ref.tenant_id,
        talent_id: ref.record_id,
      });
      if (projection === null) continue; // defensive — record vanished
      records.push({
        talent_id: projection.talent_id,
        tenant_id: projection.tenant_id,
        tenant_name: await this.resolveTenantName(projection.tenant_id),
        tenant_status: projection.tenant_status,
        source_channel: projection.source_channel,
        created_at: projection.created_at,
      });
    }
    return { records };
  }

  // GET /v1/portal/records/:id/profile — one record's R10-filtered profile.
  @Get('records/:id/profile')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:profile:read')
  async getRecordProfile(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalProfileDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const member = await this.resolveMemberOr404(sub, id, requestId);
    const projection = await this.talentRecordService.findSelfProfile({
      tenant_id: member.tenant_id,
      talent_id: member.record_id,
    });
    if (projection === null) throw this.uniformNotFound(requestId);
    return {
      talent_id: projection.talent_id,
      tenant_id: projection.tenant_id,
      tenant_name: await this.resolveTenantName(projection.tenant_id),
      tenant_status: projection.tenant_status,
      source_channel: projection.source_channel,
      created_at: projection.created_at,
    };
  }

  // GET /v1/portal/records/:id/consent — one record's consent state.
  @Get('records/:id/consent')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:consent:read')
  async getRecordConsent(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TalentConsentStateResponseDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const member = await this.resolveMemberOr404(sub, id, requestId);
    // ConsentService.getState reads under authContext.tenant_id — but the portal
    // session carries the platform sentinel, not the record's tenant. The chain
    // resolved the record's tenant; scope the read to THAT tenant (getState uses
    // only tenant_id from the context for the read).
    return this.consentService.getState(
      member.record_id,
      { ...authContext, tenant_id: member.tenant_id },
      requestId,
    );
  }

  // GET /v1/portal/records/:id/consent/text — the EXACT versioned consent text
  // (Portal P2 P2b §PR-2) the portal user must see before granting. Rendered by
  // the consent lib (same renderer that hashes the D7 preimage), named by the
  // record's tenant_id. All 5 scopes; the UI shows the one being granted. A
  // read (portal:consent:read); membership through the chain (uniform 404).
  @Get('records/:id/consent/text')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:consent:read')
  async getRecordConsentText(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalConsentTextResponseDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const member = await this.resolveMemberOr404(sub, id, requestId);
    // The consent text names the recipient by the RECORD's tenant (the chain
    // resolved it), not the portal session's platform sentinel.
    return this.consentService.getPortalConsentTexts(member.tenant_id);
  }

  // GET /v1/portal/records/:id/consent/history — the append-only consent history
  // (Portal P2 P2b §PR-2). Delegates to the consent lib's engagement-class
  // ConsentHistoryEvent projection (5 closed fields, no actor/trust leak).
  // Query params (scope, limit, cursor) optional; the service parses + clamps
  // them (decode errors → 400). A read; membership through the chain (uniform
  // 404); tenant rescoped to the record's tenant.
  @Get('records/:id/consent/history')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:consent:read')
  async getRecordConsentHistory(
    @Param('id') id: string,
    @Query('scope') scopeRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('cursor') cursorRaw: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ConsentHistoryResponseDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const member = await this.resolveMemberOr404(sub, id, requestId);
    return this.consentService.getPortalHistory({
      talent_record_id: member.record_id,
      scopeRaw,
      limitRaw,
      cursorRaw,
      authContext: { ...authContext, tenant_id: member.tenant_id },
      requestId,
    });
  }

  // POST /v1/portal/records/:id/consent/grant — portal-actor consent grant
  // (Portal P2 P2a). Membership through the OPEN-4 chain first (uniform 404); the
  // record id is the chain-resolved id, never the body. The tenant context is
  // rescoped to the record's tenant (the portal JWT carries the platform
  // sentinel); the actor is the portal principal. 201 on record.
  @Post('records/:id/consent/grant')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('portal:consent:write')
  async grantRecordConsent(
    @Param('id') id: string,
    @Body() body: PortalConsentGrantRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalConsentMutationDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const key = this.assertIdempotencyKey(idempotencyKey, requestId);
    const member = await this.resolveMemberOr404(sub, id, requestId);
    const result = await this.consentService.grantAsPortal({
      talent_record_id: member.record_id,
      scope: body.scope,
      authContext: { ...authContext, tenant_id: member.tenant_id },
      idempotencyKey: key,
      requestId,
      consentTextVersion: body.consent_text_version,
    });
    return {
      scope: result.scope,
      action: 'granted',
      occurred_at: result.occurred_at,
      expires_at: result.expires_at ?? null,
    };
  }

  // POST /v1/portal/records/:id/consent/revoke — portal-actor consent revoke
  // (Portal P2 P2a). Immediate + idempotent (revoking a non-active grant is a
  // no-op success). Same membership gate + tenant rescoping as grant.
  @Post('records/:id/consent/revoke')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('portal:consent:write')
  async revokeRecordConsent(
    @Param('id') id: string,
    @Body() body: PortalConsentRevokeRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalConsentMutationDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const key = this.assertIdempotencyKey(idempotencyKey, requestId);
    const member = await this.resolveMemberOr404(sub, id, requestId);
    const result = await this.consentService.revokeAsPortal({
      talent_record_id: member.record_id,
      scope: body.scope,
      authContext: { ...authContext, tenant_id: member.tenant_id },
      idempotencyKey: key,
      requestId,
      consentTextVersion: body.consent_text_version,
    });
    return {
      scope: result.scope,
      action: 'revoked',
      occurred_at: result.occurred_at,
      expires_at: null,
    };
  }

  // ===========================================================================
  // Portal P3a — talent verification view + dispute rights (§PR-2). These are
  // TALENT-LEVEL (aggregated across the OPEN-4 chain), NOT per-record — no
  // `:id` record path. The verification view is the trust-class wall's first live
  // surface (re-projected to kind + status + dates). Disputes are cluster-scoped:
  // a dispute id not in the caller's cluster is a UNIFORM 404. P3a fires NO TR-15
  // transition (Amendment v1.1).
  // ===========================================================================

  // GET /v1/portal/verifications — the caller's verifications across their chain.
  @Get('verifications')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:verification:read')
  async getVerifications(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalVerificationsResponseDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const clusterId = await this.resolver.resolveClusterId(sub);
    if (clusterId === null) return { verifications: [] }; // valid empty state
    const subjects = await this.resolver.resolveSubjects(sub);
    return { verifications: await this.trustService.aggregateVerifications(subjects, clusterId) };
  }

  // POST /v1/portal/disputes — open a dispute against a verification-view item.
  @Post('disputes')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('portal:dispute:write')
  async openDispute(
    @Body() body: PortalDisputeOpenRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalDisputeMutationDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    this.assertIdempotencyKey(idempotencyKey, requestId);
    const clusterId = await this.resolver.resolveClusterId(sub);
    // No cluster ⇒ no items ⇒ the item id cannot resolve: uniform 404.
    if (clusterId === null) throw this.uniformNotFound(requestId);
    const subjects = await this.resolver.resolveSubjects(sub);
    const dispute = await this.trustService.openPortalDispute({
      clusterId,
      callerSubjects: subjects,
      itemId: body.item_id,
      statement: body.statement,
      now: new Date(),
      requestId,
    });
    return this.toDisputeMutation(dispute);
  }

  // GET /v1/portal/disputes — the caller's disputes (cluster-scoped).
  @Get('disputes')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:dispute:read')
  async listDisputes(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalDisputeListResponseDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const clusterId = await this.resolver.resolveClusterId(sub);
    if (clusterId === null) return { disputes: [] };
    const rows = await this.trustService.listPortalDisputes(clusterId, { limit: 100 });
    return { disputes: rows.map((r) => this.toDisputeMutation(r)) };
  }

  // GET /v1/portal/disputes/:id — one dispute the caller owns (uniform 404).
  @Get('disputes/:id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:dispute:read')
  async getDispute(
    @Param('id') id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalDisputeDetailDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    const clusterId = await this.resolver.resolveClusterId(sub);
    if (clusterId === null) throw this.uniformNotFound(requestId);
    if (!UUID_REGEX.test(id)) throw this.uniformNotFound(requestId);
    const { dispute, statements } = await this.trustService.getPortalDispute(
      clusterId,
      id,
      requestId,
    );
    return {
      dispute_id: dispute.id,
      status: dispute.status,
      opened_at: dispute.opened_at.toISOString(),
      resolution_note: dispute.resolution_note,
      statements: statements.map((s) => ({
        statement: s.statement,
        created_at: s.created_at.toISOString(),
      })),
    };
  }

  // POST /v1/portal/disputes/:id/respond — append a talent statement (open only).
  @Post('disputes/:id/respond')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:dispute:write')
  async respondDispute(
    @Param('id') id: string,
    @Body() body: PortalDisputeRespondRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalDisputeMutationDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    this.assertIdempotencyKey(idempotencyKey, requestId);
    const clusterId = await this.resolver.resolveClusterId(sub);
    if (clusterId === null || !UUID_REGEX.test(id)) throw this.uniformNotFound(requestId);
    const dispute = await this.trustService.respondPortalDisputeStatement({
      clusterId,
      disputeId: id,
      statement: body.statement,
      requestId,
    });
    return this.toDisputeMutation(dispute);
  }

  // POST /v1/portal/disputes/:id/withdraw — terminal talent action.
  @Post('disputes/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:dispute:write')
  async withdrawDispute(
    @Param('id') id: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalDisputeMutationDto> {
    this.assertConsumerIsPortal(authContext, requestId);
    const sub = this.assertSubIsUuid(authContext, requestId);
    this.assertIdempotencyKey(idempotencyKey, requestId);
    const clusterId = await this.resolver.resolveClusterId(sub);
    if (clusterId === null || !UUID_REGEX.test(id)) throw this.uniformNotFound(requestId);
    const dispute = await this.trustService.withdrawPortalDispute({
      clusterId,
      disputeId: id,
      actor: sub, // Pin A — the portal principal on the withdrawal-fired resolve
      now: new Date(),
      requestId,
    });
    return this.toDisputeMutation(dispute);
  }

  private assertIdempotencyKey(
    key: string | undefined,
    requestId: string,
  ): string {
    if (key === undefined || key.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        400,
        { requestId, details: { missing_field: 'Idempotency-Key' } },
      );
    }
    if (!UUID_REGEX.test(key)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a UUID',
        400,
        { requestId, details: { invalid_field: 'Idempotency-Key' } },
      );
    }
    return key;
  }

  // Resolve a per-record membership or throw the uniform 404. Also rejects a
  // malformed record id as the SAME 404 (no format-vs-membership oracle).
  private async resolveMemberOr404(
    sub: string,
    recordId: string,
    requestId: string,
  ): Promise<{ tenant_id: string; record_id: string }> {
    if (!UUID_REGEX.test(recordId)) throw this.uniformNotFound(requestId);
    const member = await this.resolver.resolveMemberRecord(sub, recordId);
    if (member === null) throw this.uniformNotFound(requestId);
    return member;
  }

  private uniformNotFound(requestId: string): AramoError {
    // Uniform: no details that distinguish "unknown" from "not yours".
    return new AramoError('NOT_FOUND', 'record not found', 404, { requestId });
  }

  private assertConsumerIsPortal(
    authContext: AuthContextType,
    requestId: string,
  ): void {
    if (authContext.consumer_type !== 'portal') {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'portal endpoints are portal-consumer only',
        403,
        { requestId, details: { consumer_type: authContext.consumer_type } },
      );
    }
  }

  private assertSubIsUuid(
    authContext: AuthContextType,
    requestId: string,
  ): string {
    const sub = authContext.sub;
    if (!UUID_REGEX.test(sub)) {
      throw new AramoError(
        'INVALID_REQUEST',
        'portal token sub claim must be a UUID',
        400,
        { requestId, details: { invalid_field: 'sub' } },
      );
    }
    return sub;
  }
}
