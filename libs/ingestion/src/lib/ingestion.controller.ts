import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';

import { IngestionPayloadRequestDto } from './dto/ingestion-payload-request.dto.js';
import type { IngestionPayloadResponseDto } from './dto/ingestion-payload-response.dto.js';
import { IngestionService } from './ingestion.service.js';

// POST /v1/ingestion/payloads — generic ingestion endpoint per API
// Contracts v1.0 Phase 4 Group 2 (the generic-payload-intake group;
// PR-12 directive §4.3). The controller follows the libs/consent
// precedent:
// JwtAuthGuard at the @Controller level; tenant_id from authContext
// (NEVER request body); request body validated via class-validator
// against IngestionPayloadRequestDto (closed source enum, sha256 hex
// shape, ISO-8601 timestamps).
//
// The endpoint is consumed by the "ingestion" consumer type (already
// in the auth consumer_type enum). PR-12 ships the generic endpoint
// only; the Indeed search-results endpoint is PR-13.

@Controller('v1/ingestion')
@UseGuards(JwtAuthGuard)
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('payloads')
  @HttpCode(HttpStatus.CREATED)
  async submitPayload(
    @Body() request: IngestionPayloadRequestDto,
    @AuthContext() authContext: AuthContextType,
    @RequestId() _requestId: string,
  ): Promise<IngestionPayloadResponseDto> {
    return this.ingestionService.acceptPayload({
      tenant_id: authContext.tenant_id,
      request,
    });
  }
}
