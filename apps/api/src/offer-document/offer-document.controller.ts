import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';

import { OfferDocumentOrchestratorService } from './offer-document-orchestrator.service.js';

// DOC-6 (R-6-4) — recruiter-facing offer-letter endpoints. Thin HTTP surface over the
// OfferDocumentOrchestratorService; recruiter-only (consumer_type gate). tenant_id +
// actor come authoritatively from the auth context, never the body. The signer
// identity is resolved server-side from the Offer (PL-2) — the client supplies only
// the offer/document reference.
@Controller('v1/offer-documents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OfferDocumentController {
  constructor(private readonly orchestrator: OfferDocumentOrchestratorService) {}

  private assertRecruiter(authContext: AuthContextType, requestId: string): void {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'offer-document endpoints are recruiter-only', 403, { requestId, details: { consumer_type: authContext.consumer_type } });
    }
  }

  @Post()
  @RequireScopes('document:create')
  @HttpCode(HttpStatus.CREATED)
  async request(
    @Body() body: { offer_id?: string },
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ document_id: string; offer_id: string }> {
    this.assertRecruiter(authContext, requestId);
    if (typeof body?.offer_id !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'offer_id is required', 400, { requestId });
    }
    return this.orchestrator.request({
      tenant_id: authContext.tenant_id,
      offer_id: body.offer_id,
      created_by: authContext.sub,
      requestId,
    });
  }

  @Post(':documentId/send')
  @RequireScopes('document:execute')
  @HttpCode(HttpStatus.OK)
  async send(
    @Param('documentId') documentId: string,
    @Body() body: { offer_id?: string },
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ document_id: string; envelope_id: string; status: string }> {
    this.assertRecruiter(authContext, requestId);
    if (typeof body?.offer_id !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'offer_id is required', 400, { requestId });
    }
    return this.orchestrator.send({
      tenant_id: authContext.tenant_id,
      document_id: documentId,
      offer_id: body.offer_id,
      created_by: authContext.sub,
      requestId,
    });
  }

  // DOC-6 (R-6-4, PL-3) — DERIVED status read-model (no second stored authority).
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
