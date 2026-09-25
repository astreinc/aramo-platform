import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import {
  DocumentIdempotencyConflictError,
  DocumentNotFoundError,
  ExecutedArtifactHashMismatchError,
  RevisionSourceService,
} from '@aramo/documents';

import { EsignWriteBackOrchestrator } from './esign-writeback.js';

// DOC-4 (R-4-7) — the apps/api endpoints for the executed-artifact seam.
//   GET  /v1/documents/revisions/:id/source  — source PDF bytes esign pulls for
//                                               executed-document production.
//   POST /v1/documents/esign-writeback        — the idempotent write-back the
//                                               event consumer (SNS→HTTP / poller)
//                                               invokes: pull executed artifacts
//                                               from esign-service then store the
//                                               permanent EXECUTED + CERTIFICATE.
// Service-to-service; tenant_id is passed authoritatively by the trusted caller.

@Controller('v1/documents')
export class DocumentsEsignController {
  constructor(
    private readonly source: RevisionSourceService,
    private readonly orchestrator: EsignWriteBackOrchestrator,
  ) {}

  @Get('revisions/:id/source')
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

  @Post('esign-writeback')
  @HttpCode(HttpStatus.OK)
  async writeBack(@Body() body: { tenant_id: string; envelope_id: string; correlation_id?: string }, @RequestId() requestId: string) {
    if (typeof body?.tenant_id !== 'string' || typeof body?.envelope_id !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'tenant_id and envelope_id are required', 400, { requestId });
    }
    try {
      return await this.orchestrator.writeBackEnvelope({ tenant_id: body.tenant_id, envelope_id: body.envelope_id, correlation_id: body.correlation_id, requestId });
    } catch (e) {
      if (e instanceof ExecutedArtifactHashMismatchError) throw new AramoError('DOCUMENT_EXECUTED_HASH_MISMATCH', e.message, 422, { requestId });
      if (e instanceof DocumentIdempotencyConflictError) throw new AramoError('IDEMPOTENCY_KEY_CONFLICT', e.message, 409, { requestId });
      if (e instanceof DocumentNotFoundError) throw new AramoError('DOCUMENT_NOT_FOUND', e.message, 404, { requestId });
      throw e;
    }
  }
}
