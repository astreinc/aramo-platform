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
  TenantService,
  extractTenantSlugFromHost,
} from '@aramo/identity';
import { RefreshTokenService } from '@aramo/auth-storage';
import type { Request, Response } from 'express';

import { CookieVerifierService } from './cookie-verifier.service.js';
import { PkceService } from './pkce.service.js';
import { deriveRedirectUri } from './redirect-uri.js';
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
    private readonly tenants: TenantService,
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
    // Amendment v1.2 (Workstream D): derive the callback URL from the login-path
    // consumer `c` (the same value sealed into the PKCE state cookie below), so
    // the login-time and callback-time consumers cannot diverge by construction.
    const redirectUri = deriveRedirectUri(c);
    if (
      domain === undefined ||
      clientId === undefined ||
      redirectUri === null
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
    // Subdomain-Identity Directive B — Home Realm Discovery. If the requesting
    // host resolves to a tenant that has pinned an IdP, append the verbatim
    // Cognito identity_provider hint so the Hosted UI skips the chooser and goes
    // straight to that provider. Anything else (no tenant host, unknown/inactive
    // slug, null IdP, lookup error) leaves the URL exactly as built above → the
    // chooser shows. This is a purely additive front-door hint; it does NOT
    // touch the callback/token-exchange/reconcile spine.
    const identityProvider = await this.resolveIdentityProvider(req.get('host'));
    if (identityProvider !== null) {
      url.searchParams.set('identity_provider', identityProvider);
    }
    res.redirect(302, url.toString());
  }

  // Subdomain-Identity Directive B — resolve the requesting host to its tenant's
  // pinned Cognito identity_provider string, or null = show the chooser. FAILS
  // OPEN to null on every non-happy path: a user must always be able to reach a
  // login. The slug parse is apex-anchored (extractTenantSlugFromHost requires
  // the .aramo.ai suffix) so it can't be tricked by <slug>.attacker.com. The
  // provider string is returned VERBATIM from the column — never hardcoded — so
  // the logic stays tenant-agnostic (Astre's value happens to be 'microsoft').
  private async resolveIdentityProvider(
    host: string | undefined,
  ): Promise<string | null> {
    if (host === undefined || host.length === 0) {
      return null;
    }
    try {
      const rootDomain = process.env['APP_ROOT_DOMAIN'] ?? 'aramo.ai';
      const slug = extractTenantSlugFromHost(host, rootDomain);
      if (slug === null) {
        return null;
      }
      const tenant = await this.tenants.findActiveBySlug(slug);
      return tenant?.identity_provider ?? null;
    } catch {
      // Any resolution failure (lookup error, etc.) → fall back to the chooser,
      // never an error page.
      return null;
    }
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
      // The hosted-UI callback is a TOP-LEVEL browser redirect (Cognito
      // 302s the browser to this endpoint), so a bodyless 204 would leave
      // the browser stranded on a blank page. After the session cookies
      // are set, redirect the browser back into the app. The cookie-set
      // and token-exchange logic above is unchanged; only the success
      // response shape (204 → 302) differs.
      //
      // The redirect target is PER-ENVIRONMENT config (the frontend origin
      // for THIS environment): local/dev → the local FE origin (same-origin
      // vite proxy); staging/prod → the deployed FE URL (a DIFFERENT origin
      // from the API). It is read from AUTH_POST_LOGIN_REDIRECT and throws
      // when unset — NO hardcoded localhost fallback (which would silently
      // strand deployed users on a dev URL). Mirrors the throw-if-missing
      // posture of AUTH_COGNITO_REDIRECT_URI above and the cognito-verifier.
      const postLogin = process.env['AUTH_POST_LOGIN_REDIRECT'];
      if (postLogin === undefined || postLogin.length === 0) {
        throw new AramoError(
          'INTERNAL_ERROR',
          'Post-login redirect not configured',
          500,
          { requestId, details: { reason: 'post_login_redirect_missing' } },
        );
      }
      res.redirect(302, postLogin);
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
    if (result.kind === 'auth_error') {
      // §5 Auth-Hardening D2 P4: user/config-class failures map to a clean
      // 4xx with details.reason (debuggable first login), not a blank 500.
      //   - token-content rejections (email_not_verified, missing_email,
      //     missing_sub, wrong_token_use) → 401 INVALID_TOKEN.
      //   - no_active_tenant → 403 TENANT_ACCESS_DENIED.
      //   - user_not_provisioned (+ default) → 403 INSUFFICIENT_PERMISSIONS.
      // Existing ERROR_CODES only — no new code is registered. The reasons
      // are surfaced ONLY to a caller who already completed IdP auth (proven
      // control of the email), so they are not an account-existence
      // enumeration oracle for arbitrary accounts.
      const TOKEN_REASONS = new Set([
        'email_not_verified',
        'missing_email',
        'missing_sub',
        'wrong_token_use',
      ]);
      const details = { reason: result.reason };
      if (TOKEN_REASONS.has(result.reason)) {
        throw new AramoError('INVALID_TOKEN', 'IdP token rejected', 401, {
          requestId,
          details,
        });
      }
      if (result.reason === 'no_active_tenant') {
        throw new AramoError(
          'TENANT_ACCESS_DENIED',
          'No active tenant membership',
          403,
          { requestId, details },
        );
      }
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'Identity not provisioned',
        403,
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

  // §5 Auth-Hardening D3 — GET /auth/{consumer}/logout → 302 to the Cognito
  // hosted-UI /logout endpoint (Cognito SSO session termination).
  //
  // The POST above clears the LOCAL app session (cookies + Aramo refresh-token
  // revoke). That alone leaves the Cognito SSO session cookie alive, so a
  // "logged-out" user can be logged straight back in without re-authenticating
  // (shared-machine re-entry risk). This GET is the browser-navigation piece:
  // the frontend POSTs to clear locally, then navigates here, and we 302 the
  // browser to Cognito's hosted-UI /logout — which clears Cognito's SSO cookie
  // and returns the browser to the REGISTERED post-logout URL. This is the
  // piece that closes the re-entry-without-reauth hole.
  //
  // It mirrors the login redirect's posture: the redirect target is built
  // SERVER-SIDE from env (the frontend holds no Cognito config), so the
  // post-logout return URL (logout_uri) is a registered/allowlisted config
  // value, NEVER user-controllable — a user-supplied logout_uri would be an
  // open-redirect vuln. AUTH_COGNITO_SIGNOUT_REDIRECT throws when unset, the
  // same throw-if-missing posture as AUTH_POST_LOGIN_REDIRECT (the sign-out
  // return URL is config, not input). The endpoint is a pure idempotent
  // redirect: it reads no cookies and reveals nothing, so logging out an
  // already-logged-out session is a clean no-op (no enumeration, no leak).
  //
  // NOTE (§5 D3 §A.3 readiness carry): Cognito-side refresh-token revocation
  // (AdminUserGlobalSignOut) is intentionally NOT added here. Aramo discards
  // Cognito's refresh token at the token exchange and brokers its OWN session
  // (Aramo access JWT + Aramo refresh token), so the session-resurrection
  // vector is Aramo's own refresh token — already revoked by the POST above —
  // and the re-entry hole is the Cognito SSO cookie, closed by this redirect.
  // GlobalSignOut is defense-in-depth (not load-bearing) and is deferred to a
  // Step-3 platform-admin build (it would need auth-service's first Cognito-
  // admin SDK surface + a user_id→sub reverse-lookup + pool routing + IAM).
  @Get('logout')
  async logoutRedirect(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
  ): Promise<void> {
    const requestId = req.requestId ?? 'unknown';
    parseConsumer(consumer, requestId);
    const domain = process.env['AUTH_COGNITO_DOMAIN'];
    const clientId = process.env['AUTH_COGNITO_CLIENT_ID'];
    if (domain === undefined || clientId === undefined) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'Cognito configuration missing',
        500,
        { requestId, details: { reason: 'cognito_env_missing' } },
      );
    }
    // The REGISTERED sign-out return URL (config, never input). Throws when
    // unset — no hardcoded fallback (which would strand deployed users or, if
    // it were ever derived from the request, open an open-redirect).
    const signOutRedirect = process.env['AUTH_COGNITO_SIGNOUT_REDIRECT'];
    if (signOutRedirect === undefined || signOutRedirect.length === 0) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'Post-logout redirect not configured',
        500,
        { requestId, details: { reason: 'signout_redirect_missing' } },
      );
    }
    const url = new URL(`https://${domain}/logout`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('logout_uri', signOutRedirect);
    res.redirect(302, url.toString());
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
