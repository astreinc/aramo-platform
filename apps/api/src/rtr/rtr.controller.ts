import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';

import { RtrOrchestratorService } from './rtr-orchestrator.service.js';

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

