import { Body, Controller, Delete, Get, HttpCode, Ip, Param, Post, Query, Req, Res } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CONSUMER_HEADER, CONSUMER_TYPES, JwtAuthGuard, LEGACY_ACCESS_COOKIE, accessCookieName, type ConsumerType } from '@aramo/auth';
import type { Request, Response } from 'express';

import { AccountLinkService } from './account-link.service.js';
import type { AccountLinkMethod } from './account-link-directory.port.js';
import { NATIVE_CONSUMER, NativeAuthService } from './native-auth.service.js';

// Apple Go-Live Amendment A1 (LOCKED) L-4 — the account-linking endpoints that are
// not bound to one consumer's hosted-UI flow:
//
//   POST   /auth/link/email/start               proof (b) start   → always 202 {}
//   POST   /auth/link/email/verify              proof (b) verify  → 200 {linked, idp}
//   GET    /auth/me/sign-in-methods?consumer=c  the caller's methods
//   DELETE /auth/me/sign-in-methods/{idp}?consumer=c
//
// The email-code routes need no session (the pending-link handle is the
// capability). The methods routes take a native Bearer token (Aramo Sign mobile)
// or the browser access cookie of `consumer`. Every answer is no-store.

interface RequestWithId extends Request {
  requestId?: string;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function body(b: unknown): Record<string, unknown> {
  return b !== null && typeof b === 'object' ? (b as Record<string, unknown>) : {};
}

function consumerMismatch(requestId: string): AramoError {
  return new AramoError('INVALID_TOKEN', 'Session consumer does not match the declared consumer', 401, {
    requestId,
    details: { reason: 'consumer_header_mismatch' },
  });
}

// Reasons that mean "the handle can no longer be used" or "the code is wrong":
// 400. A policy refusal of the attach itself (identity_already_linked, ...): 409.
const VERIFY_400_REASONS = new Set(['code_invalid', 'code_expired', 'code_attempts_exceeded', 'link_expired']);

@Controller('auth')
export class AccountLinkController {
  constructor(
    private readonly links: AccountLinkService,
    private readonly jwt: JwtAuthGuard,
    private readonly native: NativeAuthService,
  ) {}

  @Post('link/email/start')
  @HttpCode(202)
  async startEmail(
    @Body() raw: unknown,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, never>> {
    noStore(res);
    const b = body(raw);
    // Same answer whatever happened (no enumeration oracle, L-4 b).
    await this.links.startEmailProof({ handle: b['link_handle'], email: b['email'], ip: ip ?? 'unknown' });
    return {};
  }

  @Post('link/email/verify')
  @HttpCode(200)
  async verifyEmail(
    @Body() raw: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ linked: true; idp: string }> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    const b = body(raw);
    const result = await this.links.verifyEmailProof({ handle: b['link_handle'], code: b['code'] });
    if (result.ok) return { linked: true, idp: result.idp };
    const details: Record<string, unknown> = { reason: result.reason };
    if ('attempts_remaining' in result) details['attempts_remaining'] = result.attempts_remaining;
    const status = VERIFY_400_REASONS.has(result.reason) ? 400 : 409;
    throw new AramoError('VALIDATION_ERROR', 'Account not connected', status, { requestId, details });
  }

  @Get('me/sign-in-methods')
  async listMethods(
    @Query('consumer') consumer: string | undefined,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ items: AccountLinkMethod[] }> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    const principal = await this.authenticate(req, consumer, requestId);
    return { items: await this.links.listSignInMethods(principal) };
  }

  @Delete('me/sign-in-methods/:idp')
  @HttpCode(204)
  async removeMethod(
    @Param('idp') idp: string,
    @Query('consumer') consumer: string | undefined,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    const principal = await this.authenticate(req, consumer, requestId);
    const result = await this.links.removeSignInMethod(principal, idp);
    if (result.ok) return;
    if (result.reason === 'last_sign_in_method') {
      throw new AramoError('VALIDATION_ERROR', 'The last sign-in method cannot be removed', 409, {
        requestId,
        details: { reason: 'last_sign_in_method' },
      });
    }
    throw new AramoError('NOT_FOUND', 'Sign-in method not found', 404, {
      requestId,
      details: { reason: 'sign_in_method_not_found' },
    });
  }

  // A native Bearer token (live device session) or the browser access cookie of
  // `consumer` (never a native token in a cookie, never the portal). Returns the
  // principal id; verified exactly as a protected route verifies it.
  private async authenticate(req: RequestWithId, consumer: string | undefined, requestId: string): Promise<string> {
    // D-ORG-4 — a consumer the front end declares (X-Aramo-Consumer) must be the
    // one named here and the one the credential was minted for.
    const declared = req.header(CONSUMER_HEADER);
    const header = req.header('authorization');
    if (header !== undefined && header.length > 0) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match === null || match[1] === undefined || match[1].length === 0) {
        throw new AramoError('AUTH_REQUIRED', 'Bearer token required', 401, { requestId, details: { reason: 'bearer_required' } });
      }
      const { context } = await this.jwt.verifyAccessToken(match[1], requestId);
      if (context.client !== 'native' || context.dsid === undefined || context.consumer_type !== NATIVE_CONSUMER) {
        throw new AramoError('INVALID_TOKEN', 'A native sign token is required', 401, {
          requestId,
          details: { reason: 'native_token_required' },
        });
      }
      if (declared !== undefined && declared !== context.consumer_type) throw consumerMismatch(requestId);
      await this.native.assertCallerSessionActive({ sub: context.sub, tenant_id: context.tenant_id, dsid: context.dsid }, requestId);
      return context.sub;
    }
    if (consumer === undefined || !(CONSUMER_TYPES as readonly string[]).includes(consumer) || consumer === 'portal') {
      throw new AramoError('VALIDATION_ERROR', 'A consumer is required', 400, { requestId, details: { reason: 'invalid_consumer' } });
    }
    const c = consumer as ConsumerType;
    const own = req.cookies?.[accessCookieName(c)];
    const cookie = typeof own === 'string' && own.length > 0 ? own : req.cookies?.[LEGACY_ACCESS_COOKIE];
    if (typeof cookie !== 'string' || cookie.length === 0) {
      throw new AramoError('AUTH_REQUIRED', 'Sign in first', 401, { requestId, details: { reason: 'session_required' } });
    }
    const { context } = await this.jwt.verifyAccessToken(cookie, requestId);
    if (context.consumer_type !== c || context.client !== undefined || (declared !== undefined && declared !== c)) {
      throw consumerMismatch(requestId);
    }
    return context.sub;
  }
}
