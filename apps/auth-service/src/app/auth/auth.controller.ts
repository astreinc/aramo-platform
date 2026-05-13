import { createHash } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CONSUMER_TYPES, type ConsumerType } from '@aramo/auth';
import {
  IdentityAuditService,
} from '@aramo/identity';
import { RefreshTokenService } from '@aramo/auth-storage';
import type { Request, Response } from 'express';

import { CookieVerifierService } from './cookie-verifier.service.js';
import { PkceService } from './pkce.service.js';
import {
  RefreshOrchestratorService,
} from './refresh-orchestrator.service.js';
import {
  SessionOrchestratorService,
  type CallbackResult,
} from './session-orchestrator.service.js';
import type { SessionResponseDto } from './dto/session-response.dto.js';

const ACCESS_COOKIE = 'aramo_access_token';
const REFRESH_COOKIE = 'aramo_refresh_token';
const PKCE_COOKIE = 'aramo_pkce_state';
const ACCESS_MAX_AGE_MS = 900 * 1000;
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PKCE_MAX_AGE_MS = 600 * 1000;

interface RequestWithCookies extends Request {
  requestId?: string;
}

function shouldSetSecure(): boolean {
  if (process.env['NODE_ENV'] === 'production') return true;
  return process.env['AUTH_ALLOW_INSECURE_COOKIES'] !== 'true';
}

function parseConsumer(value: string, requestId: string): ConsumerType {
  if (!(CONSUMER_TYPES as readonly string[]).includes(value)) {
    throw new AramoError(
      'VALIDATION_ERROR',
      `Unknown consumer "${value}"`,
      400,
      { requestId, details: { reason: 'invalid_consumer' } },
    );
  }
  return value as ConsumerType;
}

function setAccessCookie(res: Response, value: string): void {
  res.cookie(ACCESS_COOKIE, value, {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_MAX_AGE_MS,
  });
}

function setRefreshCookie(res: Response, value: string): void {
  res.cookie(REFRESH_COOKIE, value, {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'strict',
    path: '/auth',
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

function clearAccessCookie(res: Response): void {
  res.cookie(ACCESS_COOKIE, '', {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

function clearRefreshCookie(res: Response): void {
  res.cookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'strict',
    path: '/auth',
    maxAge: 0,
  });
}

function setPkceCookie(res: Response, value: string): void {
  res.cookie(PKCE_COOKIE, value, {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'lax',
    path: '/auth',
    maxAge: PKCE_MAX_AGE_MS,
  });
}

function clearPkceCookie(res: Response): void {
  res.cookie(PKCE_COOKIE, '', {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'lax',
    path: '/auth',
    maxAge: 0,
  });
}

function sha256Base64Url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

@Controller('auth/:consumer')
export class AuthController {
  constructor(
    private readonly pkce: PkceService,
    private readonly sessionOrch: SessionOrchestratorService,
    private readonly refreshOrch: RefreshOrchestratorService,
    private readonly cookieVerifier: CookieVerifierService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly audit: IdentityAuditService,
  ) {}

  // §8.1 — GET /auth/{consumer}/login → 302 + pkce_state cookie
  @Get('login')
  async login(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    const domain = process.env['AUTH_COGNITO_DOMAIN'];
    const clientId = process.env['AUTH_COGNITO_CLIENT_ID'];
    const redirectUri = process.env['AUTH_COGNITO_REDIRECT_URI'];
    if (
      domain === undefined ||
      clientId === undefined ||
      redirectUri === undefined
    ) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'Cognito configuration missing',
        500,
        { requestId, details: { reason: 'cognito_env_missing' } },
      );
    }
    const pair = this.pkce.generate();
    const cipher = this.pkce.encryptState({
      verifier: pair.verifier,
      state: pair.state,
      consumer: c,
      issued_at: Math.floor(Date.now() / 1000),
    });
    setPkceCookie(res, cipher);
    const url = new URL(`https://${domain}/oauth2/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', pair.state);
    url.searchParams.set('code_challenge', pair.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    res.redirect(302, url.toString());
  }

  // §8.2 — GET /auth/{consumer}/callback
  @Get('callback')
  async callback(
    @Param('consumer') consumer: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') cognitoError: string | undefined,
    @Query('error_description') cognitoErrorDescription: string | undefined,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    const pkceCookie = req.cookies?.[PKCE_COOKIE];
    const result: CallbackResult = await this.sessionOrch.handleCallback({
      consumer: c,
      code,
      state,
      cognitoError,
      cognitoErrorDescription,
      pkceStateCipher: pkceCookie,
    });

    // Always clear pkce_state on /callback completion (success or error).
    clearPkceCookie(res);

    if (result.kind === 'success') {
      setAccessCookie(res, result.accessJwt);
      setRefreshCookie(res, result.refreshTokenPlaintext);
      res.status(204).end();
      return;
    }
    if (result.kind === 'tenant_selection_required') {
      throw new AramoError(
        'TENANT_SELECTION_REQUIRED',
        'User has multiple active tenants; selection required',
        409,
        { requestId, details: { tenants: result.tenants } },
      );
    }
    if (result.kind === 'validation_error') {
      const details: Record<string, unknown> = { reason: result.reason };
      if (result.cognitoError !== undefined) {
        details.cognito_error = result.cognitoError;
      }
      if (result.cognitoErrorDescription !== undefined) {
        details.cognito_error_description = result.cognitoErrorDescription;
      }
      throw new AramoError(
        'VALIDATION_ERROR',
        'Callback validation failed',
        400,
        { requestId, details },
      );
    }
    // internal_error
    throw new AramoError(
      'INTERNAL_ERROR',
      'Callback failed',
      500,
      { requestId, details: { reason: result.reason } },
    );
  }

  // §8.3 — POST /auth/{consumer}/refresh
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    const refreshCookie = req.cookies?.[REFRESH_COOKIE];
    const result = await this.refreshOrch.handleRefresh({
      consumer: c,
      refreshCookie,
    });
    if (result.kind === 'success') {
      setAccessCookie(res, result.accessJwt);
      setRefreshCookie(res, result.refreshTokenPlaintext);
      res.status(200).end();
      return;
    }
    if (result.kind === 'token_invalid') {
      // Clear BOTH cookies on every 401 path per §8.3.
      clearAccessCookie(res);
      clearRefreshCookie(res);
      throw new AramoError(
        'REFRESH_TOKEN_INVALID',
        'Refresh token invalid',
        401,
        { requestId, details: { reason: result.reason } },
      );
    }
    throw new AramoError(
      'INTERNAL_ERROR',
      'Refresh failed',
      500,
      { requestId, details: { reason: result.reason } },
    );
  }

  // §8.4 — POST /auth/{consumer}/logout (idempotent)
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    const refreshCookie = req.cookies?.[REFRESH_COOKIE];
    if (refreshCookie !== undefined && refreshCookie.length > 0) {
      const tokenHash = sha256Base64Url(refreshCookie);
      const found = await this.refreshTokens.findByHash({ token_hash: tokenHash });
      if (found !== null && found.consumer_type === c) {
        await this.refreshTokens.revoke({ id: found.id });
        await this.audit.writeEvent({
          event_type: 'identity.session.revoked',
          actor_type: 'user',
          actor_id: found.user_id,
          tenant_id: found.tenant_id,
          subject_id: found.user_id,
          payload: { reason: 'logout' },
        });
      }
    }
    clearAccessCookie(res);
    clearRefreshCookie(res);
    res.status(204).end();
  }

  // §8.5 — GET /auth/{consumer}/session
  @Get('session')
  async session(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
  ): Promise<SessionResponseDto> {
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    const cookie = req.cookies?.[ACCESS_COOKIE];
    if (cookie === undefined || cookie.length === 0) {
      throw new AramoError(
        'INVALID_TOKEN',
        'Access cookie missing',
        401,
        { requestId },
      );
    }
    let payload;
    try {
      payload = await this.cookieVerifier.verify(cookie);
    } catch {
      throw new AramoError(
        'INVALID_TOKEN',
        'Access token verification failed',
        401,
        { requestId },
      );
    }
    if (payload.consumer_type !== c) {
      throw new AramoError(
        'INVALID_TOKEN',
        'Access token consumer mismatch',
        401,
        { requestId },
      );
    }
    return {
      sub: payload.sub,
      consumer_type: payload.consumer_type,
      tenant_id: payload.tenant_id,
      scopes: payload.scopes,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}
