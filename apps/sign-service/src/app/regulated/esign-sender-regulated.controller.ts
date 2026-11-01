import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { EsignSenderBoundary } from '@aramo/identity';

import { senderHttp } from '../sender/envelope-contracts.js';
import { ESIGN_CREATE_SCOPE, ESIGN_READ_SCOPE } from '../sender/sender-context.service.js';

import { RegulatedSigningService } from './regulated-signing.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.16 / §1.19 under Amendment A1 —
// the sender routes of the QES and India e-stamp workflows. Same authenticated SENDER zone
// as EsignSenderController (EsignSenderBoundary: JwtAuthGuard → `sign` consumer → `sign`
// capability → scope); ownership and visibility are checked in the service.
//
//   GET  v1/sign/sender/envelopes/:id/qes                              sign:envelope:read
//   PUT  v1/sign/sender/envelopes/:id/signers/:signerId/signature-level sign:envelope:create
//   GET  v1/sign/sender/envelopes/:id/estamp                           sign:envelope:read
//   POST v1/sign/sender/envelopes/:id/estamp                           sign:envelope:create
//   POST v1/sign/sender/envelopes/:id/estamp/refresh                   sign:envelope:create
//
// Every route is refused while `sign.qes` / `sign.india_estamp` is NOT_AVAILABLE
// (ESIGN_FEATURE_NOT_AVAILABLE, 403) — today, always.
@Controller('v1/sign/sender')
@UseFilters(AramoExceptionFilter)
export class EsignSenderRegulatedController {
  constructor(private readonly regulated: RegulatedSigningService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw senderHttp(e, requestId);
    }
  }

  @Get('envelopes/:id/qes')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  qes(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.regulated.qesStatus(auth, id, requestId));
  }

  @Put('envelopes/:id/signers/:signerId/signature-level')
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  signatureLevel(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Param('signerId') signerId: string,
    @Body() body: { signature_level?: unknown },
  ) {
    return this.run(requestId, () => this.regulated.setSignatureLevel(auth, id, signerId, body, requestId));
  }

  @Get('envelopes/:id/estamp')
  @EsignSenderBoundary(ESIGN_READ_SCOPE)
  estamp(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.regulated.estampStatus(auth, id, requestId));
  }

  @Post('envelopes/:id/estamp')
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  requestEstamp(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.run(requestId, () => this.regulated.requestEstamp(auth, id, body, requestId));
  }

  @Post('envelopes/:id/estamp/refresh')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary(ESIGN_CREATE_SCOPE)
  refreshEstamp(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.regulated.refreshEstamp(auth, id, requestId));
  }
}
