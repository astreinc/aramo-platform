import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';

import { ConsentService } from './consent.service.js';
import { ConsentCheckRequestDto } from './dto/consent-check-request.dto.js';
import type { ConsentDecisionDto } from './dto/consent-decision.dto.js';
import {
  CONSENT_SCOPES,
  ConsentGrantRequestDto,
  type ConsentScopeValue,
} from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';
import { ConsentRevokeRequestDto } from './dto/consent-revoke-request.dto.js';
import type { ConsentRevokeResponseDto } from './dto/consent-revoke-response.dto.js';
import type { ConsentHistoryResponseDto } from './dto/consent-history-response.dto.js';
import type { TalentConsentStateResponseDto } from './dto/talent-consent-state-response.dto.js';
import {
  CursorDecodeError,
  decodeCursor,
  type HistoryCursorPayload,
} from './util/history-cursor.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/consent')
@UseGuards(JwtAuthGuard)
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  @Post('grant')
  @HttpCode(HttpStatus.CREATED)
  async grantConsent(
    @Body() request: ConsentGrantRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ConsentGrantResponseDto> {
    this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    return this.consentService.grant(
      request,
      idempotencyKey as string,
      authContext,
      requestId,
    );
  }

  @Post('revoke')
  @HttpCode(HttpStatus.CREATED)
  async revokeConsent(
    @Body() request: ConsentRevokeRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ConsentRevokeResponseDto> {
    this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    return this.consentService.revoke(
      request,
      idempotencyKey as string,
      authContext,
      requestId,
    );
  }

  // PR-4: /consent/check is a 200-returning endpoint with the decision in
  // the response body. Idempotency-Key is OPTIONAL per Phase 1 §6 line 497.
  @Post('check')
  @HttpCode(HttpStatus.OK)
  async checkConsent(
    @Body() request: ConsentCheckRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ConsentDecisionDto> {
    this.assertIdempotencyKeyOptional(idempotencyKey, requestId);
    return this.consentService.check(
      request,
      idempotencyKey,
      authContext,
      requestId,
    );
  }

  // PR-5: GET /consent/state/{talent_id}. Informational read endpoint;
  // no Idempotency-Key handling (Phase 1 §6: N/A for read endpoints).
  // No request body. talent_id is a path parameter; UUID format
  // validated explicitly because @Param doesn't run class-validator.
  @Get('state/:talent_id')
  @HttpCode(HttpStatus.OK)
  async getTalentConsentState(
    @Param('talent_id') talent_id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TalentConsentStateResponseDto> {
    this.assertTalentIdFormat(talent_id, requestId);
    return this.consentService.getState(talent_id, authContext, requestId);
  }

  // PR-6: GET /consent/history/{talent_id}. Informational read endpoint;
  // no Idempotency-Key (Phase 1 §6: N/A for read endpoints). Query params
  // (scope, limit, cursor) all optional; validated/clamped per directive
  // §5. Cursor decode errors mapped to HTTP 400 VALIDATION_ERROR; never
  // propagate as 500 (directive §3).
  @Get('history/:talent_id')
  @HttpCode(HttpStatus.OK)
  async getTalentConsentHistory(
    @Param('talent_id') talent_id: string,
    @Query('scope') scopeRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('cursor') cursorRaw: string | undefined,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ConsentHistoryResponseDto> {
    this.assertTalentIdFormat(talent_id, requestId);
    const scope = this.parseScopeFilter(scopeRaw, requestId);
    const limit = this.parseLimit(limitRaw, requestId);
    const cursor = this.parseCursor(cursorRaw, requestId);
    return this.consentService.getHistory(
      talent_id,
      scope,
      limit,
      cursor,
      authContext,
      requestId,
    );
  }

  private assertIdempotencyKeyRequired(
    idempotencyKey: string | undefined,
    requestId: string,
  ): void {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        400,
        { requestId, details: { missing_field: 'Idempotency-Key' } },
      );
    }
    this.assertIdempotencyKeyFormat(idempotencyKey, requestId);
  }

  // /consent/check accepts an absent header but still rejects malformed
  // values. Same UUID regex as the grant/revoke required check.
  private assertIdempotencyKeyOptional(
    idempotencyKey: string | undefined,
    requestId: string,
  ): void {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      return;
    }
    this.assertIdempotencyKeyFormat(idempotencyKey, requestId);
  }

  private assertIdempotencyKeyFormat(
    idempotencyKey: string,
    requestId: string,
  ): void {
    if (!UUID_REGEX.test(idempotencyKey)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a UUID',
        400,
        { requestId, details: { invalid_field: 'Idempotency-Key' } },
      );
    }
  }

  private assertTalentIdFormat(talent_id: string, requestId: string): void {
    if (!UUID_REGEX.test(talent_id)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'talent_id must be a UUID',
        400,
        { requestId, details: { invalid_field: 'talent_id' } },
      );
    }
  }

  // PR-6 §5 page size validation:
  //   omitted        → default 50
  //   > 200          → clamped to 200
  //   < 1            → 400 VALIDATION_ERROR
  //   non-integer    → 400 VALIDATION_ERROR
  private parseLimit(limitRaw: string | undefined, requestId: string): number {
    if (limitRaw === undefined || limitRaw === '') {
      return 50;
    }
    // Reject non-integer (including negatives, decimals, non-numeric)
    if (!/^-?\d+$/.test(limitRaw)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'limit must be a positive integer',
        400,
        { requestId, details: { invalid_field: 'limit' } },
      );
    }
    const parsed = Number.parseInt(limitRaw, 10);
    if (parsed < 1) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'limit must be at least 1',
        400,
        { requestId, details: { invalid_field: 'limit' } },
      );
    }
    return parsed > 200 ? 200 : parsed;
  }

  // PR-6 §5 scope filter: optional, single-valued, must be a known
  // ConsentScope value when present.
  private parseScopeFilter(
    scopeRaw: string | undefined,
    requestId: string,
  ): ConsentScopeValue | undefined {
    if (scopeRaw === undefined || scopeRaw === '') {
      return undefined;
    }
    if (!(CONSENT_SCOPES as readonly string[]).includes(scopeRaw)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `scope must be one of ${CONSENT_SCOPES.join(', ')}`,
        400,
        { requestId, details: { invalid_field: 'scope' } },
      );
    }
    return scopeRaw as ConsentScopeValue;
  }

  // PR-6 §5 cursor decoding: optional. Decode errors mapped to HTTP 400
  // VALIDATION_ERROR; must not propagate as 500 (directive §3 + §9).
  private parseCursor(
    cursorRaw: string | undefined,
    requestId: string,
  ): HistoryCursorPayload | undefined {
    if (cursorRaw === undefined || cursorRaw === '') {
      return undefined;
    }
    try {
      return decodeCursor(cursorRaw);
    } catch (err) {
      if (err instanceof CursorDecodeError) {
        throw new AramoError(
          'VALIDATION_ERROR',
          err.message,
          400,
          { requestId, details: { invalid_field: 'cursor' } },
        );
      }
      throw err;
    }
  }
}
