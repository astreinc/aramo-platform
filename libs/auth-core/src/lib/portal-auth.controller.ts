import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { deriveBaseFromHost } from './redirect-uri.js';
import { PortalLoginService } from './portal-login.service.js';

// Portal P1 — the passwordless portal login controller, DECOUPLED from the
// Cognito AuthController (which stays @Controller('auth/:consumer') and
// untouched). A dedicated STATIC @Controller('auth/portal') owns the magic-link
// routes + the PortalLoginService dependency, so adding portal auth never
// touches AuthController's constructor (and never breaks the sibling test
// modules that hand-build AuthController).
//
// Route non-collision (substrate-confirmed): AuthController's leaf verbs are
// {login, callback, refresh, logout, session}; NONE is request-link/consume, so
// the static 'auth/portal/request-link' and 'auth/portal/consume' routes are
// never shadowed by the 'auth/:consumer/<verb>' param routes. ('auth/portal/login'
// still resolves to AuthController with consumer='portal', harmlessly — portal
// never uses the Cognito login.)
//
// The cookie shape below MIRRORS auth.controller.ts VERBATIM (same names, flags,
// TTLs) — it is the same session contract, deliberately duplicated here to keep
// AuthController a clean revert.

const ACCESS_COOKIE = 'aramo_access_token';
const REFRESH_COOKIE = 'aramo_refresh_token';
const ACCESS_MAX_AGE_MS = 900 * 1000;
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface RequestWithCookies extends Request {
  requestId?: string;
}

function shouldSetSecure(): boolean {
  if (process.env['NODE_ENV'] === 'production') return true;
  return process.env['AUTH_ALLOW_INSECURE_COOKIES'] !== 'true';
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

// The ONE neutral request-link response (rulings 1 & 2): byte-identical whether
// the email is eligible, ineligible, or malformed-but-parseable.
const PORTAL_REQUEST_LINK_NEUTRAL_RESPONSE = {
  message: 'If this address is known to Aramo, a sign-in link has been sent.',
} as const;

// The portal base for the magic-link URL + the consume redirect. Derived from the
// request host via the portal host class (exact-match allowlist); falls back to
// PORTAL_LOGIN_BASE_URL (dev), never the raw Host.
function portalBaseUrl(req: Request): string {
  const derived = deriveBaseFromHost(req.get('host'), { isTenantHost: false });
  return derived ?? process.env['PORTAL_LOGIN_BASE_URL'] ?? 'http://localhost:4203';
}

@Controller('auth/portal')
export class PortalAuthController {
  constructor(private readonly portalLogin: PortalLoginService) {}

  // POST /auth/portal/request-link — body {email}. Always the identical neutral
  // response; the side effect (mail or none) is invisible to the caller.
  @Post('request-link')
  @HttpCode(200)
  async requestLink(
    @Body() body: { email?: unknown } | undefined,
    @Ip() ip: string,
    @Req() req: RequestWithCookies,
  ): Promise<{ message: string }> {
    await this.portalLogin.requestLink({
      email: body?.email,
      ip: ip ?? 'unknown',
      baseUrl: portalBaseUrl(req),
    });
    return PORTAL_REQUEST_LINK_NEUTRAL_RESPONSE;
  }

  // GET /auth/portal/consume?token=… — the magic-link click. On success set the
  // session cookies; ALWAYS 302 to the portal base (the SPA reads the session,
  // P3). A failure sets no cookies — indistinguishable to a third party.
  @Get('consume')
  async consume(
    @Query('token') token: string | undefined,
    @Ip() ip: string,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.portalLogin.consume({
      rawToken: token,
      ip: ip ?? 'unknown',
    });
    if (result.kind === 'success') {
      setAccessCookie(res, result.accessJwt);
      setRefreshCookie(res, result.refreshTokenPlaintext);
    }
    res.redirect(302, portalBaseUrl(req));
  }
}
