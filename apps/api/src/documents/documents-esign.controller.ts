import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { RevisionSourceService } from '@aramo/documents';

import { EsignServiceRequestGuard } from '../integrations/sign/esign-service-request.guard.js';

// DOC-4 (R-4-7) — the apps/api source-document seam for sign-service.
//   GET /v1/documents/revisions/:id/source — source PDF bytes sign-service pulls
//   for executed-document production and the signer document view.
//
// ES-2 (Aramo-E-Sign-ES-2-Core-Service-Trust-Implementation-Authorization-v1_0):
// - The route is authenticated as an sign-service request (EsignServiceRequestGuard,
//   scheme aramo-sign-s2s-v1). tenant_id stays the caller-supplied scope — it is
//   bound by the signature, and the read remains tenant-scoped below.
// - The transitional POST /v1/documents/esign-writeback route is RETIRED: it never
//   had an HTTP caller. The canonical E-Sign -> Core callback is the signed webhook
//   POST /v1/integrations/sign/events, which drives EsignWriteBackOrchestrator
//   in-process (unchanged).

@Controller('v1/documents')
export class DocumentsEsignController {
  constructor(private readonly source: RevisionSourceService) {}

  @Get('revisions/:id/source')
  @UseGuards(EsignServiceRequestGuard)
  @HttpCode(HttpStatus.OK)
  async getRevisionSource(@Param('id') revisionId: string, @Query('tenant_id') tenantId: string, @RequestId() requestId: string) {
    if (typeof tenantId !== 'string' || tenantId.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'tenant_id is required', 400, { requestId });
    }
    const source_base64 = await this.source.getSourceBase64(tenantId, revisionId, requestId);
    if (source_base64 === null) {
      throw new AramoError('DOCUMENT_NOT_FOUND', `no source artifact for revision ${revisionId}`, 404, { requestId });
    }
    return { revision_id: revisionId, source_base64 };
  }
}
