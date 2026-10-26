import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { CONSUMER_HEADER, JwtAuthGuard } from '@aramo/auth';
import type { Request, Response } from 'express';

import {
  NATIVE_CONSUMER,
  NativeAuthService,
  parseNativeTokenRequest,
  parseRefreshTokenBody,
  type NativeCaller,
  type NativeSessionItem,
  type NativeTokenResponse,
} from './native-auth.service.js';

// AUTH-SIGNIN-1 Amendment M-A1 — the native authentication consumer endpoints
// (Aramo Sign mobile). Tokens travel in JSON bodies only, never as cookies;
// every response here is `Cache-Control: no-store` (§3.9). No browser host is
// resolved or simulated on these routes (§3.7): the native context is enforced
// by NativeAuthService instead.

interface RequestWithId extends Request {
  requestId?: string;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

@Controller('auth/native/sign')
export class NativeAuthController {
  constructor(
    private readonly native: NativeAuthService,
    private readonly jwt: JwtAuthGuard,
  ) {}

  @Post('token')
  @HttpCode(200)
  async token(
    @Body() body: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NativeTokenResponse> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    return this.native.exchange(parseNativeTokenRequest(body, requestId), requestId);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() body: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NativeTokenResponse> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    return this.native.refresh(parseRefreshTokenBody(body, requestId), requestId);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() body: unknown,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    await this.native.logout(parseRefreshTokenBody(body, requestId));
  }

  @Get('sessions')
  async sessions(
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ items: NativeSessionItem[] }> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    const caller = await this.authenticate(req, requestId);
    return this.native.listSessions(caller, requestId);
  }

  @Delete('sessions/:device_session_id')
  @HttpCode(204)
  async revoke(
    @Param('device_session_id') deviceSessionId: string,
    @Req() req: RequestWithId,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    noStore(res);
    const requestId = req.requestId ?? 'unknown';
    const caller = await this.authenticate(req, requestId);
    await this.native.revokeSession(caller, deviceSessionId, requestId);
  }

  // Device operations need an authenticated NATIVE Bearer token (never a
  // cookie): verified exactly as a protected route verifies it (signature,
  // issuer, audience, claims, server-side authorization revision), then required
  // to carry the native context for the `sign` consumer.
  private async authenticate(req: RequestWithId, requestId: string): Promise<NativeCaller> {
    const header = req.header('authorization');
    const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header);
    if (match === null || match[1] === undefined || match[1].length === 0) {
      throw new AramoError('AUTH_REQUIRED', 'Bearer token required', 401, {
        requestId,
        details: { reason: 'bearer_required' },
      });
    }
    const { context } = await this.jwt.verifyAccessToken(match[1], requestId);
    const declared = req.header(CONSUMER_HEADER);
    if (declared !== undefined && declared !== context.consumer_type) {
      throw new AramoError('INVALID_TOKEN', 'Session consumer does not match the declared consumer', 401, {
        requestId,
        details: { reason: 'consumer_header_mismatch' },
      });
    }
    if (context.client !== 'native' || context.dsid === undefined || context.consumer_type !== NATIVE_CONSUMER) {
      throw new AramoError('INVALID_TOKEN', 'A native sign token is required', 401, {
        requestId,
        details: { reason: 'native_token_required' },
      });
    }
    return { sub: context.sub, tenant_id: context.tenant_id, dsid: context.dsid };
  }
}

// ── Browser fallback pages (M-A1 §6; Lead Architect P-5 ruling, 2026-10-26) ──
//
// Two public pages that a browser shows only when the app did NOT take the URL:
//   GET /auth/native/callback    the registered https OAuth callback. Normally the
//                                verified app link (Android) or the auth session
//                                (iOS 17.4+) hands it to the app before any page
//                                loads. Reaching the server means the app did not
//                                open; the page says so and nothing more.
//   GET /auth/native/signed-out  the registered Cognito sign-out URL.
//
// Neither page reads the request. No query parameter, header or path segment is
// echoed, forwarded or used as a destination: the authorization code and state on
// a callback URL are never put into the page or a link (they are single-use and
// PKCE-bound, and the page has no reason to carry them). The only link is the
// FIXED app address `aramosign://`, so there is no open redirect. No script runs
// (CSP default-src 'none'), the page cannot be framed, it is never cached, and
// `Referrer-Policy: no-referrer` keeps the callback URL out of any onward request.

const NATIVE_APP_HOME = 'aramosign://';

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function nativePage(title: string, heading: string, body: string, linkLabel: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #ffffff; color: #1a1d24; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  main { max-width: 420px; padding: 32px 24px; text-align: center; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { margin: 0 0 24px; color: #5b6170; }
  a { display: inline-block; padding: 12px 20px; border-radius: 10px; background: #0029c7; color: #ffffff; text-decoration: none; font-weight: 600; }
  @media (prefers-color-scheme: dark) { body { background: #111318; color: #eef0f4; } p { color: #a7adba; } }
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
<p>${body}</p>
<a href="${NATIVE_APP_HOME}">${linkLabel}</a>
</main>
</body>
</html>
`;
}

export const NATIVE_CALLBACK_FALLBACK_PAGE = nativePage(
  'Aramo Sign',
  'Finish signing in in the app',
  'Aramo Sign did not open on this device. Open the Aramo Sign app and sign in again from there.',
  'Open Aramo Sign',
);

export const NATIVE_SIGNED_OUT_PAGE = nativePage(
  'Signed out - Aramo Sign',
  'You are signed out',
  'You have signed out of Aramo Sign on this device.',
  'Return to Aramo Sign',
);

function sendNativePage(res: Response, html: string): void {
  noStore(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(200).send(html);
}

// Registered BEFORE AuthController in the auth-service module: AuthController's
// GET /auth/:consumer/callback would otherwise take /auth/native/callback (Express
// matches routes in registration order) and answer "Unknown consumer".
@Controller('auth/native')
export class NativeAuthPagesController {
  @Get('callback')
  callback(@Res() res: Response): void {
    sendNativePage(res, NATIVE_CALLBACK_FALLBACK_PAGE);
  }

  @Get('signed-out')
  signedOut(@Res() res: Response): void {
    sendNativePage(res, NATIVE_SIGNED_OUT_PAGE);
  }
}
