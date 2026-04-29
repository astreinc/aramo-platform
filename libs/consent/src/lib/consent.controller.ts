import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';

import { ConsentService } from './consent.service.js';
import { ConsentGrantRequestDto } from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';

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
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required',
        400,
        { requestId, details: { missing_field: 'Idempotency-Key' } },
      );
    }
    if (!UUID_REGEX.test(idempotencyKey)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a UUID',
        400,
        { requestId, details: { invalid_field: 'Idempotency-Key' } },
      );
    }
    return this.consentService.grant(
      request,
      idempotencyKey,
      authContext,
      requestId,
    );
  }
}
