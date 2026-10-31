import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseFilters } from '@nestjs/common';
import { AramoError, AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE } from '@aramo/identity';

import { toHttp } from '../esign-http.controller.js';

import { type CreateBody, SignApiService } from './sign-api.service.js';
import { SignApiBoundary, type SignApiRequest, type SignIntegrationContext } from './sign-api.guard.js';
import { SignTokenService, type TokenRequest } from './sign-token.service.js';

// Sign Unified Product S-4 (directive §4.4) — the Sign token endpoint and the Sign
// API. First-party exposure first (D-13): these routes are served by sign-service
// on the internal network; public third-party exposure is a separate activation.

function integration(req: SignApiRequest, requestId: string): SignIntegrationContext {
  if (req.signIntegration === undefined) throw new AramoError('AUTH_REQUIRED', 'A valid Aramo Sign access token is required', 401, { requestId });
  return req.signIntegration;
}

// Accepts client credentials in the body or as HTTP Basic (RFC 6749 §2.3.1).
function withBasicAuth(body: TokenRequest, authorization: string | undefined): TokenRequest {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(authorization ?? '');
  if (m === null || m[1] === undefined) return body;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i <= 0) return body;
  return { ...body, client_id: decodeURIComponent(decoded.slice(0, i)), client_secret: decodeURIComponent(decoded.slice(i + 1)) };
}

@Controller('v1/sign/oauth')
@UseFilters(AramoExceptionFilter)
export class SignOAuthController {
  constructor(private readonly tokens: SignTokenService) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  token(@Body() body: TokenRequest, @Headers('authorization') authorization: string | undefined, @RequestId() requestId: string) {
    return this.tokens.issue(withBasicAuth(body ?? {}, authorization), requestId);
  }
}

@Controller('v1/sign/api')
@UseFilters(AramoExceptionFilter)
export class SignApiController {
  constructor(private readonly api: SignApiService) {}

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  // Retention and Purge directive (ebd41d99) W1 — the tenant retention setting over the API.
  @Get('retention-policy')
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_READ)
  getRetentionPolicy(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string) {
    return this.run(requestId, () => this.api.getRetentionPolicy(auth, integration(req, requestId), requestId));
  }

  @Put('retention-policy')
  @SignApiBoundary(ESIGN_SCOPE.SETTINGS_MANAGE)
  setRetentionPolicy(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Body() body: { retention_days?: unknown; purge_level?: unknown }) {
    return this.run(requestId, () => this.api.setRetentionPolicy(auth, integration(req, requestId), body ?? {}, requestId));
  }

  @Get('availability')
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_READ)
  availability(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string) {
    return this.run(requestId, () => this.api.availability(auth, integration(req, requestId), requestId));
  }

  @Post('envelopes')
  @HttpCode(HttpStatus.CREATED)
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_CREATE)
  create(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Body() body: CreateBody) {
    return this.run(requestId, () => this.api.create(auth, integration(req, requestId), body ?? {}, requestId));
  }

  // Declared before `:id` so the literal path is not shadowed.
  @Get('envelopes/for-document')
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_READ)
  forDocument(
    @AuthContext() auth: AuthContextType,
    @Req() req: SignApiRequest,
    @RequestId() requestId: string,
    @Query('document_ref') documentRef?: string,
    @Query('document_revision_ref') revisionRef?: string,
  ) {
    if (typeof documentRef !== 'string' || typeof revisionRef !== 'string') {
      throw new AramoError('VALIDATION_ERROR', 'document_ref and document_revision_ref are required', 400, { requestId });
    }
    return this.run(requestId, () => this.api.forDocument(auth, integration(req, requestId), documentRef, revisionRef, requestId));
  }

  @Get('envelopes/:id')
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_READ)
  get(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.api.get(auth, integration(req, requestId), id, requestId));
  }

  @Get('envelopes/:id/evidence')
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_READ)
  evidence(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.api.evidence(auth, integration(req, requestId), id, requestId));
  }

  @Get('envelopes/:id/executed')
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_READ)
  executed(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.api.executed(auth, integration(req, requestId), id, requestId));
  }

  @Post('envelopes/:id/send')
  @HttpCode(HttpStatus.OK)
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_SEND)
  send(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Param('id') id: string) {
    return this.run(requestId, () => this.api.send(auth, integration(req, requestId), id, requestId));
  }

  @Post('envelopes/:id/remind')
  @HttpCode(HttpStatus.OK)
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_SEND)
  remind(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { signer_id?: unknown } = {}) {
    return this.run(requestId, () => this.api.remind(auth, integration(req, requestId), id, requestId, body?.signer_id));
  }

  @Post('envelopes/:id/void')
  @HttpCode(HttpStatus.OK)
  @SignApiBoundary(ESIGN_SCOPE.ENVELOPE_SEND)
  void(@AuthContext() auth: AuthContextType, @Req() req: SignApiRequest, @RequestId() requestId: string, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return this.run(requestId, () => this.api.void(auth, integration(req, requestId), id, body?.reason, requestId));
  }
}
