import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { ConsentService, type TalentConsentStateResponseDto } from '@aramo/consent';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { TalentRecordService } from '@aramo/talent-record';

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
  ) {}

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
