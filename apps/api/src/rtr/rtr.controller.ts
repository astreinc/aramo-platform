import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';

import {
  RtrOrchestratorService,
  type RtrComposeView,
  type RtrCurrentView,
  type RtrPreviewView,
  type RtrRemindResult,
} from './rtr-orchestrator.service.js';

// DOC-5 (R-5-5) — recruiter-facing RTR endpoints. Thin HTTP surface over the
// RtrOrchestratorService; recruiter-only (consumer_type gate). tenant_id +
// actor come authoritatively from the auth context, never the body.
@Controller('v1/rtr')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RtrController {
  constructor(private readonly orchestrator: RtrOrchestratorService) {}

  private assertRecruiter(authContext: AuthContextType, requestId: string): void {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'RTR endpoints are recruiter-only', 403, { requestId, details: { consumer_type: authContext.consumer_type } });
    }
  }

  @Post()
  @RequireScopes('document:create')
  @HttpCode(HttpStatus.CREATED)
  async request(
    @Body() body: { talent_id?: string; requisition_id?: string; company_id?: string },
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ document_id: string }> {
    this.assertRecruiter(authContext, requestId);
    if (typeof body?.talent_id !== 'string' || typeof body?.requisition_id !== 'string' || typeof body?.company_id !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'talent_id, requisition_id, company_id are required', 400, { requestId });
    }
    return this.orchestrator.request({
      tenant_id: authContext.tenant_id,
      talent_id: body.talent_id,
      requisition_id: body.requisition_id,
      company_id: body.company_id,
      created_by: authContext.sub,
      requestId,
    });
  }

  @Post(':documentId/send')
  @RequireScopes('document:execute')
  @HttpCode(HttpStatus.OK)
  async send(
    @Param('documentId') documentId: string,
    @Body() body: { talent_id?: string },
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ document_id: string; envelope_id: string; status: string }> {
    this.assertRecruiter(authContext, requestId);
    if (typeof body?.talent_id !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'talent_id is required', 400, { requestId });
    }
    return this.orchestrator.send({
      tenant_id: authContext.tenant_id,
      document_id: documentId,
      talent_id: body.talent_id,
      created_by: authContext.sub,
      requestId,
    });
  }

  // COMM-RECRUITER-W1 (W1-C3) — send a reminder against the SAME RTR Document,
  // SAME frozen revision, and SAME E-Sign envelope. Recruiter-only; document:execute
  // (same authority as send). Allowed only while AWAITING_SIGNATURE. Never
  // re-renders, re-resolves a template, or creates a new envelope.
  @Post(':documentId/remind')
  @RequireScopes('document:execute')
  @HttpCode(HttpStatus.OK)
  async remind(
    @Param('documentId') documentId: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RtrRemindResult> {
    this.assertRecruiter(authContext, requestId);
    return this.orchestrator.remind({
      tenant_id: authContext.tenant_id,
      document_id: documentId,
      requestId,
    });
  }

  // RTR-TEMPLATE-1 (§14) — the authoritative current RTR for an exact
  // tenant + talent + requisition (reconciliation, so the panel restores on
  // reload). Returns { current: null } when none exists (normal). Provenance is
  // from the pinned version, never today's active template. Requires document:read.
  @Get('current')
  @RequireScopes('document:read')
  @HttpCode(HttpStatus.OK)
  async current(
    @Query('talent_id') talentId: string,
    @Query('requisition_id') requisitionId: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ current: RtrCurrentView | null }> {
    this.assertRecruiter(authContext, requestId);
    if (typeof talentId !== 'string' || typeof requisitionId !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'talent_id and requisition_id query params are required', 400, { requestId });
    }
    const current = await this.orchestrator.current({
      tenant_id: authContext.tenant_id,
      talent_id: talentId,
      requisition_id: requisitionId,
      requestId,
    });
    return { current };
  }

  // SEAM 4 — read-only composition of the "Send RTR" panel BEFORE an RTR document
  // exists (talent_responded / qualifying-not-sent). Returns the tenant's ACTIVE RTR
  // template provenance { name, version_number } + a REAL-BOUND preview { title,
  // blocks } rendered for THIS (talent, requisition). No body, no mutation. Fails
  // closed on the same typed template/binding codes as the request/send path.
  // Recruiter-only; document:read (same authority as GET current). Tenant from auth.
  @Get('compose')
  @RequireScopes('document:read')
  @HttpCode(HttpStatus.OK)
  async compose(
    @Query('talent_id') talentId: string,
    @Query('requisition_id') requisitionId: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RtrComposeView> {
    this.assertRecruiter(authContext, requestId);
    if (typeof talentId !== 'string' || typeof requisitionId !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'talent_id and requisition_id query params are required', 400, { requestId });
    }
    return this.orchestrator.composeForPair({
      tenant_id: authContext.tenant_id,
      talent_id: talentId,
      requisition_id: requisitionId,
      actor_id: authContext.sub,
      requestId,
    });
  }

  // RTR-TEMPLATE-1 (§16) — presigned read access to the EXACT frozen unsigned
  // artifact the send path will transmit. Never exposes the storage key.
  // Requires document:read; tenant resolved from the auth context.
  @Get(':documentId/preview')
  @RequireScopes('document:read')
  @HttpCode(HttpStatus.OK)
  async preview(
    @Param('documentId') documentId: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RtrPreviewView> {
    this.assertRecruiter(authContext, requestId);
    return this.orchestrator.preview(authContext.tenant_id, documentId, requestId);
  }

  // DOC-5 (R-5-12, PL-3) — DERIVED status read-model (no second stored authority).
  // Executed-document bytes/artifacts are viewed via GET /v1/documents/:id/artifacts.
  @Get(':documentId/status')
  @RequireScopes('document:read')
  @HttpCode(HttpStatus.OK)
  async status(
    @Param('documentId') documentId: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ document_id: string; status: string; document_status: string }> {
    this.assertRecruiter(authContext, requestId);
    return this.orchestrator.status(authContext.tenant_id, documentId);
  }
}

