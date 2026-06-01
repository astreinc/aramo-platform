import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { ConsentService, type TalentConsentStateResponseDto } from '@aramo/consent';
import { TalentService } from '@aramo/talent';

import type { PortalProfileDto } from './dto/portal-profile.dto.js';

// M3 PR-9 Portal Controller — the foundation slice surface.
//
// Two endpoints:
//   GET /v1/portal/profile  — talent's own profile (R10-filtered projection)
//   GET /v1/portal/consent  — talent's own consent state (reuses
//                              ConsentService.getState; the existing
//                              recruiter-facing surface is unchanged)
//
// Auth posture (directive §2 Ruling 5): portal JWT carries
// `sub: <talent_uuid>` — the portal session embodies the talent it
// represents. Both endpoints derive `talent_id` from `authContext.sub`
// rather than accepting it as a path/body parameter. This is the
// structural enforcement that a portal talent can only see their own
// data: there is no surface to pass any other talent_id.
//
// Per-route consumer_type === 'portal' assertion mirrors the PR-8
// recruiter-only pattern; non-portal consumers (recruiter, ingestion)
// are 403'd at the route, not just authenticated.
//
// R10 refusal enforcement is structural, not runtime: this controller
// emits only PortalProfileDto + TalentConsentStateResponseDto. Both
// shapes are openapi-bound with additionalProperties: false, and
// ci/scripts/verify-portal-refusal.ts walks openapi/portal.yaml on
// every CI build to confirm zero R10-class fields exist in the schemas.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PR-A1a-4 §2 — route enforcement applied to portal routes.
// JwtAuthGuard runs first (AuthN); RolesGuard runs second (AuthZ) and is
// a no-op on any handler without metadata. @RequireScopes added per the
// directive §1 mapping: GET /profile → portal:profile:read,
// GET /consent → portal:consent:read. The portal-user role's seed
// catalog (libs/identity/prisma/seed.ts) carries both scopes.
//
// Rejection envelope is a superset (PR-A1a-4 Ruling 1):
// INSUFFICIENT_PERMISSIONS may carry details:{consumer_type} from the
// controller-body assertConsumerIsPortal OR details:{required_scopes,
// missing_scopes} from RolesGuard. Both are valid 403 paths. The
// portal-thin consumer pact subset-asserts only the stable contract
// (status 403 + code INSUFFICIENT_PERMISSIONS).
@Controller('v1/portal')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PortalController {
  constructor(
    private readonly talentService: TalentService,
    private readonly consentService: ConsentService,
  ) {}

  @Get('profile')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:profile:read')
  async getProfile(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<PortalProfileDto> {
    // Step 1 — auth: consumer_type === 'portal'.
    this.assertConsumerIsPortal(authContext, requestId);
    // Step 2 — talent_id derived from authContext.sub.
    const talent_id = this.assertSubIsUuid(authContext, requestId);
    // Step 3 — tenant_id from auth context (JWT claim).
    const tenant_id = authContext.tenant_id;
    // Step 4 — repository call (TalentService.findSelfProfile).
    const projection = await this.talentService.findSelfProfile({
      tenant_id,
      talent_id,
    });
    // Step 5 — 404 on null (no overlay in this tenant → resource absent).
    if (projection === null) {
      throw new AramoError(
        'NOT_FOUND',
        'No portal profile exists for this talent in this tenant',
        404,
        { requestId, details: { talent_id, tenant_id } },
      );
    }
    // Step 6 — return DTO (structurally identical to PortalProfileProjection).
    return {
      talent_id: projection.talent_id,
      tenant_id: projection.tenant_id,
      lifecycle_status: projection.lifecycle_status,
      tenant_status: projection.tenant_status,
      source_channel: projection.source_channel,
      created_at: projection.created_at,
    };
  }

  @Get('consent')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:consent:read')
  async getOwnConsent(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TalentConsentStateResponseDto> {
    // Step 1 — auth: consumer_type === 'portal'.
    this.assertConsumerIsPortal(authContext, requestId);
    // Step 2 — talent_id derived from authContext.sub.
    const talent_id = this.assertSubIsUuid(authContext, requestId);
    // Step 3 — call existing ConsentService.getState (resolves all 5 scopes
    // from the consent event ledger; same path used by the recruiter-facing
    // /v1/consent/state/{talent_id} endpoint).
    // Step 4 — return TalentConsentStateResponseDto verbatim (no re-shaping;
    // the existing DTO already carries the R10-safe fields).
    return this.consentService.getState(talent_id, authContext, requestId);
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
        {
          requestId,
          details: { consumer_type: authContext.consumer_type },
        },
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
