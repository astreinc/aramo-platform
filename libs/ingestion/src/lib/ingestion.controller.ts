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

import { IndeedSearchResultsRequestDto } from './dto/indeed-search-results-request.dto.js';
import type { IndeedSearchResultsResponseDto } from './dto/indeed-search-results-response.dto.js';
import { IngestionPayloadRequestDto } from './dto/ingestion-payload-request.dto.js';
import type { IngestionPayloadResponseDto } from './dto/ingestion-payload-response.dto.js';
import { IngestionService } from './ingestion.service.js';

// libs/ingestion controller — two endpoints under /v1/ingestion:
//
// POST /v1/ingestion/payloads — generic ingestion endpoint
// (PR-12; Phase 4 Group 2). Passive intake; closed source enum;
// dedup keyed on sha256 + verified_email + profile_url.
//
// POST /v1/ingestion/indeed/search-results — Indeed Two-Phase
// Step 1 (PR-13; Phase 4 Group 3 Step 1). Passive intake — the
// recruiter ran the search externally. No contact data extracted.
// Records stored as shortlisted_not_unlocked. Source-derived
// consent registered via SourceConsentService per Group 2 v2.3a
// (Indeed = PARTIAL consent; contacting limited to Indeed channel).
//
// Both routes follow the libs/consent precedent: JwtAuthGuard at
// the @Controller level; tenant_id from authContext (NEVER request
// body); request body validated via class-validator. The endpoints
// are consumed by the "ingestion" consumer type (already in the
// auth consumer_type enum).

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

  @Post('indeed/search-results')
  @HttpCode(HttpStatus.CREATED)
  async submitIndeedSearchResults(
    @Body() request: IndeedSearchResultsRequestDto,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<IndeedSearchResultsResponseDto> {
    return this.ingestionService.acceptIndeedSearchResults({
      tenant_id: authContext.tenant_id,
      requestId,
      request,
    });
  }
}
