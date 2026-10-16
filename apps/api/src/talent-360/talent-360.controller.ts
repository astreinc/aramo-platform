import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { RequestId, resolveAppTimeZone } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type {
  CommunicationPreviewView,
  Talent360View,
  TalentDocumentContentView,
} from './dto/talent-360.view.js';
import { Talent360Service } from './talent-360.service.js';

// The app timezone all "today"/aging is computed against (My Desk §38
// precedent). A single configured zone for v1 (Astre / tenant-50 is US-East);
// per-tenant/site timezone is a future enhancement, called out honestly.
const APP_TIME_ZONE = resolveAppTimeZone();

// GET /v1/talent-360/:talentId — the person-centric recruiter workspace READ
// composition. One route, one visibility-scoped payload (the FE renders what the
// backend already composed and never re-derives business meaning). This is a
// READ PROJECTION ONLY: no mutation, no workflow (directive §4/§27). Route
// classified AP; documented in OpenAPI (architect-authorized). Guard chain +
// base scope mirror the Talent Detail read it replaces (`talent:read`); each
// composed SECTION additionally honors its own contributing domain scope inside
// the service (directive §17.8), so composition never broadens access. Tenant +
// visibility are resolved server-side from the principal; NO client-supplied
// tenant/user/requisition id is ever trusted (directive §24). It lives in
// apps/api because only apps/api may know all owners (the My Desk / Talent
// Journey precedent) — libs boundaries forbid a cross-domain composition in a
// single domain lib.
@Controller('v1/talent-360')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class Talent360Controller {
  constructor(private readonly service: Talent360Service) {}

  @Get(':talentId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<Talent360View> {
    const [visibility, visible_requisition_ids, visible_contact_ids] =
      await Promise.all([
        req.resolveVisibility!(),
        req.resolveVisibleRequisitionIds!(),
        req.resolveVisibleContactIds!(),
      ]);
    return this.service.compose(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
        visibility,
        visible_requisition_ids,
        visible_contact_ids,
        // The caller's held scope set — each composed section is gated on the
        // contributing domain scope inside the service (§17.8).
        scopes: new Set(authContext.scopes ?? []),
        request_id: requestId,
      },
      talentId,
      Date.now(),
      APP_TIME_ZONE,
    );
  }

  // GET /v1/talent-360/:talentId/communications/:interactionId — the full sent
  // email behind a Recent-activity row (subject/body/addressing). READ ONLY.
  // Requires talent:read (the workspace) AND communication:read (the message);
  // the service constrains it to this Talent's emails and to visible
  // requisitions, refusing with a tenant-safe 404.
  @Get(':talentId/communications/:interactionId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read', 'communication:read')
  @RequireSiteMatch()
  async communicationPreview(
    @AuthContext() authContext: AuthContextType,
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @Param('interactionId', ParseUUIDPipe) interactionId: string,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<CommunicationPreviewView> {
    const [visibility, visible_requisition_ids, visible_contact_ids] =
      await Promise.all([
        req.resolveVisibility!(),
        req.resolveVisibleRequisitionIds!(),
        req.resolveVisibleContactIds!(),
      ]);
    return this.service.previewCommunication(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
        visibility,
        visible_requisition_ids,
        visible_contact_ids,
        scopes: new Set(authContext.scopes ?? []),
        request_id: requestId,
      },
      talentId,
      interactionId,
    );
  }

  // GET /v1/talent-360/:talentId/documents/:documentId/content — a Talent
  // document's file for the READ-ONLY preview (PO ruling: no view is recorded).
  // Requires talent:read AND document:read; the service constrains it to this
  // Talent's documents and visible requisitions (tenant-safe 404).
  @Get(':talentId/documents/:documentId/content')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read', 'document:read')
  @RequireSiteMatch()
  async documentContent(
    @AuthContext() authContext: AuthContextType,
    @Param('talentId', ParseUUIDPipe) talentId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TalentDocumentContentView> {
    const [visibility, visible_requisition_ids, visible_contact_ids] =
      await Promise.all([
        req.resolveVisibility!(),
        req.resolveVisibleRequisitionIds!(),
        req.resolveVisibleContactIds!(),
      ]);
    return this.service.documentContent(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
        visibility,
        visible_requisition_ids,
        visible_contact_ids,
        scopes: new Set(authContext.scopes ?? []),
        request_id: requestId,
      },
      talentId,
      documentId,
    );
  }
}
