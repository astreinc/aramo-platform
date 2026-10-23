import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  SourceSystemMismatchError,
  VerificationRefusedError,
  VerificationService,
  VerificationStatusService,
  VerificationUnavailableError,
  type ServicePrincipal,
} from '@aramo/intelligence-core';
import {
  INTELLIGENCE_VERIFY_SCOPE,
  type ConfirmVerificationResponse,
  type CreateVerificationResponse,
  type PortalVerificationsResponse,
  type VerificationRefusalCode,
} from '@aramo/intelligence-contracts';

import { RequireScope, ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';
import { lifecycle } from '../lifecycle/lifecycle-errors.js';

// ATI-SEP-1 T4 — talent identifier verification (scope intelligence:verify).
//   POST /v1/verifications               201 CreateVerificationResponse
//   POST /v1/verifications/:id/confirm   200 ConfirmVerificationResponse
//   GET  /v1/verifications?reference=…   200 PortalVerificationsResponse (T10 M-6: the portal
//        aggregate over the references the ATS passes for the talent; TI never maps portal sessions)
// Refusals: 400 INVALID_REQUEST · 403 SOURCE_SYSTEM_MISMATCH · 404 REFERENCE_NOT_FOUND /
// VERIFICATION_NOT_FOUND · 409 ALREADY_CONFIRMED · 410 VERIFICATION_EXPIRED ·
// 422 INVALID_CODE (attempts_remaining) · 423 VERIFICATION_LOCKED · 503 VERIFICATION_UNAVAILABLE.

const STATUS: Record<VerificationRefusalCode, HttpStatus> = {
  INVALID_REQUEST: HttpStatus.BAD_REQUEST,
  REFERENCE_NOT_FOUND: HttpStatus.NOT_FOUND,
  VERIFICATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  ALREADY_CONFIRMED: HttpStatus.CONFLICT,
  VERIFICATION_EXPIRED: HttpStatus.GONE,
  INVALID_CODE: HttpStatus.UNPROCESSABLE_ENTITY,
  VERIFICATION_LOCKED: HttpStatus.LOCKED,
  VERIFICATION_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

function mapError(err: unknown): never {
  if (err instanceof VerificationRefusedError) {
    throw new HttpException({ error: { code: err.code, message: err.message, ...err.details } }, STATUS[err.code]);
  }
  if (err instanceof VerificationUnavailableError) {
    throw new HttpException(
      { error: { code: 'VERIFICATION_UNAVAILABLE', message: 'verification is not configured' } },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
  if (err instanceof SourceSystemMismatchError) {
    throw new HttpException({ error: { code: 'SOURCE_SYSTEM_MISMATCH', message: err.message } }, HttpStatus.FORBIDDEN);
  }
  throw err;
}

@Controller('v1/verifications')
@UseGuards(ServiceTokenGuard)
@RequireScope(INTELLIGENCE_VERIFY_SCOPE)
export class VerificationController {
  constructor(
    private readonly verifications: VerificationService,
    private readonly status: VerificationStatusService,
  ) {}

  @Get()
  aggregate(@Query('reference') reference: unknown, @Req() req: ServiceRequest): Promise<PortalVerificationsResponse> {
    return lifecycle(() => this.status.forPortal(reference, req.servicePrincipal as ServicePrincipal));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Req() req: ServiceRequest): Promise<CreateVerificationResponse> {
    try {
      return await this.verifications.create(body, req.servicePrincipal as ServicePrincipal);
    } catch (err) {
      mapError(err);
    }
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown): Promise<ConfirmVerificationResponse> {
    try {
      const r = await this.verifications.confirm(id, body);
      return { verification_id: r.verification_id, status: 'CONFIRMED', outcome: r.outcome };
    } catch (err) {
      mapError(err);
    }
  }
}
