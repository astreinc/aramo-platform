import { Body, Controller, HttpCode, HttpException, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import {
  EventIdReusedError,
  GovIdTokenizationUnavailableError,
  IngestRejectedError,
  ReferenceErasedError,
  SourceSystemMismatchError,
  TalentIngestService,
  type ServicePrincipal,
} from '@aramo/intelligence-core';
import type { TalentErasedResponse, TalentIngestResponse } from '@aramo/intelligence-contracts';

import { ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';

// ATI-SEP-1 T2 — the ingestion surface (ADR-0036 §3/§4, Addendum A1).
//   POST /v1/ingest/talent         full snapshot of one source reference
//   POST /v1/ingest/talent/erased  the source reference was erased
// Bodies are validated by the closed admission schema in the service (the
// global ValidationPipe does not apply to an untyped body). Error mapping:
//   400 DOCUMENT_REJECTED | CLASS_C_REJECTED | INVALID_REQUEST (quarantined)
//   403 SOURCE_SYSTEM_MISMATCH · 409 EVENT_ID_REUSED | REFERENCE_ERASED
//   503 GOV_ID_TOKENIZATION_UNAVAILABLE

function mapError(err: unknown): never {
  if (err instanceof IngestRejectedError) {
    throw new HttpException(
      { error: { code: err.code, message: 'the request is not admissible', issues: err.issues } },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (err instanceof SourceSystemMismatchError) {
    throw new HttpException({ error: { code: 'SOURCE_SYSTEM_MISMATCH', message: err.message } }, HttpStatus.FORBIDDEN);
  }
  if (err instanceof EventIdReusedError) {
    throw new HttpException({ error: { code: 'EVENT_ID_REUSED', message: err.message } }, HttpStatus.CONFLICT);
  }
  if (err instanceof ReferenceErasedError) {
    throw new HttpException({ error: { code: 'REFERENCE_ERASED', message: err.message } }, HttpStatus.CONFLICT);
  }
  if (err instanceof GovIdTokenizationUnavailableError) {
    throw new HttpException(
      { error: { code: 'GOV_ID_TOKENIZATION_UNAVAILABLE', message: 'government identifiers cannot be accepted right now' } },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  throw err;
}

@Controller('v1/ingest/talent')
@UseGuards(ServiceTokenGuard)
export class IngestController {
  constructor(private readonly ingest: TalentIngestService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async snapshot(@Body() body: unknown, @Req() req: ServiceRequest): Promise<TalentIngestResponse> {
    try {
      return await this.ingest.ingest(body, req.servicePrincipal as ServicePrincipal);
    } catch (err) {
      mapError(err);
    }
  }

  @Post('erased')
  @HttpCode(HttpStatus.OK)
  async erased(@Body() body: unknown, @Req() req: ServiceRequest): Promise<TalentErasedResponse> {
    try {
      return await this.ingest.erase(body, req.servicePrincipal as ServicePrincipal);
    } catch (err) {
      mapError(err);
    }
  }
}
