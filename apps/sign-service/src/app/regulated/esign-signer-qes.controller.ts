import { Body, Controller, HttpCode, HttpStatus, Post, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';

import { toHttp } from '../esign-http.controller.js';

import { regulatedHttp } from './regulated-http.js';
import { RegulatedSigningService } from './regulated-signing.service.js';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.16 under Amendment A1 — the
// signer side of the QES workflow. Capability-token authorized like every signer route
// (the token travels in the body; the tenant is resolved server-side from the session).
//
//   POST v1/sign/signing/qes/status    the signer's QES state (null when not required)
//   POST v1/sign/signing/qes/begin     → { state, redirect_url } (the QTSP identity step)
//   POST v1/sign/signing/qes/complete  { code, state } from the QTSP redirect
//                                      → AUTHORIZED + redirect_url, then SIGNED
//
// Refused while `sign.qes` is NOT_AVAILABLE (ESIGN_FEATURE_NOT_AVAILABLE, 403) — today, always.
@Controller('v1/sign/signing')
@UseFilters(AramoExceptionFilter)
export class EsignSignerQesController {
  constructor(private readonly regulated: RegulatedSigningService) {}

  private async run<T>(body: { token?: unknown } | undefined, requestId: string, fn: (token: string) => Promise<T>): Promise<T> {
    if (typeof body?.token !== 'string' || body.token.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'token is required', 400, { requestId });
    }
    const token = body.token;
    try {
      return await fn(token);
    } catch (e) {
      throw regulatedHttp(e, requestId) ?? toHttp(e, requestId);
    }
  }

  @Post('qes/status')
  @HttpCode(HttpStatus.OK)
  status(@Body() body: { token?: unknown }, @RequestId() requestId: string) {
    return this.run(body, requestId, (token) => this.regulated.signerQesStatus(token, requestId));
  }

  @Post('qes/begin')
  @HttpCode(HttpStatus.OK)
  begin(@Body() body: { token?: unknown }, @RequestId() requestId: string) {
    return this.run(body, requestId, (token) => this.regulated.signerQesBegin(token, requestId));
  }

  @Post('qes/complete')
  @HttpCode(HttpStatus.OK)
  complete(@Body() body: { token?: unknown; code?: unknown; state?: unknown }, @RequestId() requestId: string) {
    return this.run(body, requestId, (token) => this.regulated.signerQesComplete(token, body, requestId));
  }
}
