import { createHash } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  CONSUMER_TYPES,
  LEGACY_ACCESS_COOKIE,
  LEGACY_PKCE_COOKIE,
  LEGACY_REFRESH_COOKIE,
  accessCookieName,
  allRefreshCookieNames,
  pkceCookieName,
  refreshCookieName,
  EFFECTIVE_AUTHORIZATION_RESOLVER,
  type ConsumerType,
  type EffectiveAuthorizationResolver,
} from '@aramo/auth';
import { RefreshTokenService } from '@aramo/auth-storage';
import type { Request, Response } from 'express';

import { isLinkHandle } from './account-link.service.js';
import { AUDIT_SINK, type AuditSink } from './audit-sink.port.js';
import { CookieVerifierService } from './cookie-verifier.service.js';
import { HostBaseResolver } from './host-base-resolver.service.js';
import {
  TENANT_ACCESS_DENIED_REASONS,
  allowUnboundHost,
  evaluateSessionHostBinding,
  readHostBindingMode,
} from './host-binding.js';
import { PkceService } from './pkce.service.js';
import {
  deriveRedirectUri,
  derivePostLoginRedirect,
  sanitizeReturnTo,
  deriveSignoutRedirect,
  resolvePublicBaseUrl,
  defaultPostLoginPath,
} from './redirect-uri.js';
import {
  RefreshOrchestratorService,
} from './refresh-orchestrator.service.js';
import {
  SessionOrchestratorService,
  type CallbackResult,
} from './session-orchestrator.service.js';
import type { SessionResponseDto } from './dto/session-response.dto.js';

// D-ORG-4 — cookie names are CONSUMER-ISOLATED (`aramo_access_token_<consumer>` …),
// resolved through the single naming authority in @aramo/auth
// (session-cookie-names.ts). The legacy unsuffixed names remain readable as a
// transition fallback and are cleared on every logout. See that module's header.
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

function setAccessCookie(res: Response, consumer: ConsumerType, value: string): void {
  res.cookie(accessCookieName(consumer), value, {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_MAX_AGE_MS,
  });
}

function setRefreshCookie(res: Response, consumer: ConsumerType, value: string): void {
  res.cookie(refreshCookieName(consumer), value, {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'strict',
    path: '/auth',
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

// Clears the consumer's cookie AND the legacy unsuffixed cookie (transition).
function clearAccessCookie(res: Response, consumer: ConsumerType): void {
  for (const name of [accessCookieName(consumer), LEGACY_ACCESS_COOKIE]) {
    res.cookie(name, '', {
      httpOnly: true,
      secure: shouldSetSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  }
}

function clearRefreshCookie(res: Response, consumer: ConsumerType): void {
  for (const name of [refreshCookieName(consumer), LEGACY_REFRESH_COOKIE]) {
    res.cookie(name, '', {
      httpOnly: true,
      secure: shouldSetSecure(),
      sameSite: 'strict',
      path: '/auth',
      maxAge: 0,
    });
  }
}

function setPkceCookie(res: Response, consumer: ConsumerType, value: string): void {
  res.cookie(pkceCookieName(consumer), value, {
    httpOnly: true,
    secure: shouldSetSecure(),
    sameSite: 'lax',
    path: '/auth',
    maxAge: PKCE_MAX_AGE_MS,
  });
}

function clearPkceCookie(res: Response, consumer: ConsumerType): void {
  for (const name of [pkceCookieName(consumer), LEGACY_PKCE_COOKIE]) {
    res.cookie(name, '', {
      httpOnly: true,
      secure: shouldSetSecure(),
      sameSite: 'lax',
      path: '/auth',
      maxAge: 0,
    });
  }
}

// Read a consumer's cookie, falling back to the legacy unsuffixed name.
function readCookie(req: RequestWithCookies, name: string, legacy: string): string | undefined {
  const own = req.cookies?.[name];
  if (own !== undefined && own.length > 0) return own;
  const old = req.cookies?.[legacy];
  return old !== undefined && old.length > 0 ? old : undefined;
}

function sha256Base64Url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

// The request Host as HostBaseResolver wants it (undefined when absent).
function requestHost(req: RequestWithCookies): string | undefined {
  return typeof req.get === 'function' ? req.get('host') : undefined;
}

// AUTH-SIGNIN-1 §3.1.1 — closed allowlist: the page's button value → the exact
// Cognito provider name. Any other value yields no hint. Apple Go-Live R-1:
// `apple` → `SignInWithApple`.
export function mapIdpHint(raw: string | undefined | null): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'google') return 'Google';
  if (v === 'microsoft') return 'microsoft';
  if (v === 'apple' || v === 'signinwithapple') return 'SignInWithApple';
  return null;
}

// Apple Go-Live R-1 — a tenant's pinned provider is stored as the Aramo value
// (`google` | `microsoft` | `apple`, set by the first owner federation) and must
// reach Cognito as the exact provider name. A value outside the allowlist (a
// historical verbatim Cognito name) is passed through unchanged, as before.
export function mapPinnedIdpHint(pinned: string): string {
  return mapIdpHint(pinned) ?? pinned;
}

// The provider list the sign-in page shows (AUTH-SIGNIN-1 §3.1.2; Apple Go-Live R-2).
export const LOGIN_OPTION_PROVIDERS = ['microsoft', 'google', 'apple'] as const;

// Apple Go-Live R-5 — base64url(JSON {email, given_name, family_name}) for the
// signup page's URL fragment (a fragment never reaches a server or a log).
export function encodeSignupHandoff(input: { email: string; given_name: string | null; family_name: string | null }): string {
  return Buffer.from(
    JSON.stringify({ email: input.email, given_name: input.given_name, family_name: input.family_name }),
    'utf8',
  ).toString('base64url');
}

// Apple Go-Live A1 L-2 — the /login URL fragment that carries a pending link.
function pendingLinkFragment(link: { handle: string; idp: string }): string {
  return `link=${encodeURIComponent(link.handle)}&idp=${encodeURIComponent(link.idp)}`;
}

// The relative path + one query parameter, resolved on `base` (never another origin).
function withQueryParam(base: string, path: string, key: string, value: string): string {
  const url = new URL(path, `${base}/`);
  url.searchParams.set(key, value);
  return url.toString();
}

@Controller('auth/:consumer')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly pkce: PkceService,
    private readonly sessionOrch: SessionOrchestratorService,
    private readonly refreshOrch: RefreshOrchestratorService,
    private readonly cookieVerifier: CookieVerifierService,
    private readonly refreshTokens: RefreshTokenService,
    @Inject(AUDIT_SINK) private readonly auditSink: AuditSink,
    private readonly hostBase: HostBaseResolver,
    // HF-AUTH-1 — /session resolves the effective scopes server-side (the compact
    // cookie carries none), using the SAME resolver the api guard uses so portal
    // (fixed scopes) and stale/fail-closed semantics are identical.
    @Inject(EFFECTIVE_AUTHORIZATION_RESOLVER)
    private readonly authzResolver: EffectiveAuthorizationResolver,
  ) {}

  // §8.1 — GET /auth/{consumer}/login → 302 + pkce_state cookie
  @Get('login')
  async login(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
    // Host-binding SSO recovery — `?select_account=1` asks Microsoft to show its
    // account picker instead of silently re-using the account already signed in
    // on this browser (the wrong-account case host binding detects). Verified
    // against PROD Cognito 2026-10-15: the Hosted UI forwards `prompt` to the
    // Microsoft OIDC authorize URL, both with the identity_provider hint (tenant
    // hosts) and from the chooser page's IdP buttons (platform host). Only the
    // exact value '1' is honoured, and the forwarded prompt is a fixed constant —
    // no caller-supplied value ever reaches the authorize URL.
    @Query('select_account') selectAccount?: string,
    @Query('return_to') returnTo?: string,
    // AUTH-SIGNIN-1 §3.1.1 — the provider button the user chose on the Aramo
    // sign-in page. CLOSED allowlist (google → Google, microsoft → microsoft);
    // the caller's string is never forwarded. A tenant's pinned provider WINS.
    // Absent/unknown → no hint (Cognito chooser; fail-open UI). The backend
    // still enforces provider policy at the callback (AUTH-SIGNIN-1 R1/R4).
    @Query('idp') idp?: string,
    // Apple Go-Live R-5 (web) — `intent=signup`: an unprovisioned result hands
    // off to the Personal signup page (no session, no pending link).
    @Query('intent') intent?: string,
    // Apple Go-Live A1 L-4 proof (a) — the pending-link handle from the /login
    // fragment, sealed into the encrypted state cookie (never echoed or logged).
    @Query('link') link?: string,
  ): Promise<void> {
    await this.startHostedUi(req, res, consumer, {
      selectAccount: selectAccount === '1',
      returnTo,
      idp,
      intent: intent === 'signup' ? 'signup' : null,
      linkHandle: isLinkHandle(link) ? link : null,
      linkUserId: null,
      linkReturn: null,
    });
  }

  // Apple Go-Live A1 L-4 path 1 — GET /auth/{consumer}/link?idp=<p>&return=<path>.
  // Requires this consumer's browser session cookie. Starts the hosted UI for the
  // chosen provider with the signed-in principal sealed into the state; the
  // callback attaches the new identity to it (proof c) and redirects to
  // `<return>?linked=<p>` or `<return>?link_error=<reason>`. No session is minted.
  @Get('link')
  async link(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
    @Res() res: Response,
    @Query('idp') idp?: string,
    @Query('return') returnPath?: string,
  ): Promise<void> {
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    if (mapIdpHint(idp) === null) {
      throw new AramoError('VALIDATION_ERROR', 'Unknown sign-in provider', 400, {
        requestId,
        details: { reason: 'invalid_idp' },
      });
    }
    const principal = await this.requireBrowserSession(req, c, requestId);
    const v = (idp ?? '').trim().toLowerCase();
    await this.startHostedUi(req, res, consumer, {
      // Google / Microsoft: show the account picker so a different account can be
      // chosen; Apple has no picker prompt (W4).
      selectAccount: v !== 'apple',
      returnTo: undefined,
      idp,
      intent: null,
      linkHandle: null,
      linkUserId: principal,
      linkReturn: sanitizeReturnTo(returnPath, c) ?? defaultPostLoginPath(c),
      // The chosen provider wins even on a pinned host: the attach policy (A1 L-5)
      // decides whether a second provider is allowed.
      ignorePin: true,
    });
  }

  // A valid browser session for consumer `c` (never a native token): the
  // principal id. 401 otherwise.
  private async requireBrowserSession(req: RequestWithCookies, c: ConsumerType, requestId: string): Promise<string> {
    const cookie = readCookie(req, accessCookieName(c), LEGACY_ACCESS_COOKIE);
    if (cookie === undefined || cookie.length === 0) {
      throw new AramoError('AUTH_REQUIRED', 'Sign in first', 401, { requestId, details: { reason: 'session_required' } });
    }
    let payload;
    try {
      payload = await this.cookieVerifier.verify(cookie);
    } catch {
      throw new AramoError('INVALID_TOKEN', 'Access token verification failed', 401, { requestId });
    }
    if (payload.consumer_type !== c || payload.client !== undefined) {
      throw new AramoError('INVALID_TOKEN', 'Access token consumer mismatch', 401, { requestId });
    }
    const resolution = await this.authzResolver.resolve({
      tenant_id: payload.tenant_id,
      principal_id: payload.sub,
      consumer_type: payload.consumer_type,
      actor_kind: 'user',
      token_authz_version: payload.authz_version,
      ...(payload.site_id !== undefined ? { site_id: payload.site_id } : {}),
    });
    if (resolution.status !== 'ok') {
      throw new AramoError('INVALID_TOKEN', 'Access token authorization not resolvable', 401, {
        requestId,
        details: { reason: resolution.status === 'stale' ? 'authz_version_stale' : 'authz_unresolvable' },
      });
    }
    return payload.sub;
  }

  private async startHostedUi(
    req: RequestWithCookies,
    res: Response,
    consumer: string,
    opts: {
      selectAccount: boolean;
      returnTo: string | undefined;
      idp: string | undefined;
      intent: 'signup' | null;
      linkHandle: string | null;
      linkUserId: string | null;
      linkReturn: string | null;
      ignorePin?: boolean;
    },
  ): Promise<void> {
    const { selectAccount, returnTo, idp } = opts;
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    const domain = process.env['AUTH_COGNITO_DOMAIN'];
    const clientId = process.env['AUTH_COGNITO_CLIENT_ID'];
    // PR-3.1 §3a: ONE host resolution yields BOTH the derived base (for the
    // callback redirect_uri, §3d.1) AND the tenant's pinned IdP (HRD hint, §3a
    // sharing choice). derivedBase is null for an unvalidated host → the redirect
    // falls back to the env chain (never the raw host — the §2 invariant).
    const { derivedBase, identityProvider, hostClass, contextId } =
      await this.hostBase.resolve(req.get('host'));
    // Amendment v1.2 (Workstream D): derive the callback URL from the login-path
    // consumer `c` (the same value sealed into the PKCE state cookie below), so
    // the login-time and callback-time consumers cannot diverge by construction.
    // PR-3.1: derivedBase (the validated login host) wins over the env chain.
    const redirectUri = deriveRedirectUri(c, derivedBase);
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
    // IC-2 PR-4 (F-5): seal the login host's class + context alongside the
    // consumer, so the callback binds the resolved identity to the host the
    // user actually logged in on. null = unvalidated host (unbound under F-6).
    const cipher = this.pkce.encryptState({
      verifier: pair.verifier,
      state: pair.state,
      consumer: c,
      issued_at: Math.floor(Date.now() / 1000),
      host_class: hostClass ?? null,
      context_id: contextId ?? null,
      // D-ORG-2 — same-host relative deep link, validated against the consumer's app base.
      return_to: sanitizeReturnTo(returnTo, c),
      // Apple Go-Live R-5 / A1 L-4 — present only when used (cookie size unchanged otherwise).
      ...(opts.intent !== null ? { intent: opts.intent } : {}),
      ...(opts.linkHandle !== null ? { link_handle: opts.linkHandle } : {}),
      ...(opts.linkUserId !== null ? { link_user_id: opts.linkUserId, link_return: opts.linkReturn } : {}),
    });
    setPkceCookie(res, c, cipher);
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
    // Cognito identity_provider hint so the Hosted UI skips the chooser. The
    // value comes from the SAME hostBase.resolve lookup above (§3a sharing) —
    // VERBATIM from the column, never hardcoded; null on any non-happy path
    // (no tenant host, unknown/inactive slug, null IdP, lookup error) leaves the
    // chooser showing. Purely additive front-door hint; does NOT touch the
    // callback/token-exchange/reconcile spine.
    // Apple Go-Live R-1 — the pinned Aramo value is mapped to the Cognito
    // provider name (apple → SignInWithApple, google → Google).
    if (identityProvider !== null && opts.ignorePin !== true) {
      url.searchParams.set('identity_provider', mapPinnedIdpHint(identityProvider));
    } else {
      const chosen = mapIdpHint(idp);
      if (chosen !== null) url.searchParams.set('identity_provider', chosen);
    }
    if (selectAccount) {
      url.searchParams.set('prompt', 'select_account');
    }
    res.redirect(302, url.toString());
  }

  // AUTH-SIGNIN-1 §3.1.2 — GET /auth/{consumer}/login-options. Unauthenticated,
  // host-derived, no PII: the providers the Aramo sign-in page shows on THIS
  // host. A pinned tenant host → only its provider (Astre → ["microsoft"]);
  // otherwise both. UI only — authorization is enforced at the callback.
  @Get('login-options')
  async loginOptions(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
  ): Promise<{ providers: string[] }> {
    const requestId = req.requestId ?? 'unknown';
    parseConsumer(consumer, requestId);
    const { identityProvider } = await this.hostBase.resolve(req.get('host'));
    const raw = identityProvider === null ? null : identityProvider.trim().toLowerCase();
    // Apple Go-Live R-1/R-2 — `apple` (or its Cognito name) is a pin too.
    const pinned = raw === 'signinwithapple' ? 'apple' : raw;
    if (pinned !== null && (LOGIN_OPTION_PROVIDERS as readonly string[]).includes(pinned)) return { providers: [pinned] };
    return { providers: [...LOGIN_OPTION_PROVIDERS] };
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
    const pkceCookie = readCookie(req, pkceCookieName(c), LEGACY_PKCE_COOKIE);
    // PR-3.1 §3d.1: derive the base from THIS (callback) request's host and
    // thread it into the exchange leg — same browser host as login (via the front door),
    // so the exchange redirect_uri == authorize redirect_uri by construction.
    // The derivedBase is also used for the post-login redirect (§3d.2) below.
    const { derivedBase, hostClass, contextId } = await this.hostBase.resolve(
      req.get('host'),
    );
    const result: CallbackResult = await this.sessionOrch.handleCallback({
      consumer: c,
      code,
      state,
      cognitoError,
      cognitoErrorDescription,
      pkceStateCipher: pkceCookie,
      derivedBase,
      // IC-2 PR-4: the callback host's class/context, compared with the sealed
      // login context inside the orchestrator (F-5).
      hostClass,
      contextId,
    });

    // Always clear pkce_state on /callback completion (success or error).
    clearPkceCookie(res, c);

    if (result.kind === 'success') {
      setAccessCookie(res, c, result.accessJwt);
      setRefreshCookie(res, c, result.refreshTokenPlaintext);
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
      //
      // PR-3.1 §3d.2: a VALIDATED host lands the user back on the originating
      // host (${derivedBase}${AUTH_POST_LOGIN_PATH ?? '/'}); an unvalidated host
      // falls back to the legacy full-URL AUTH_POST_LOGIN_REDIRECT (existing
      // behavior). The throw survives when neither resolves.
      const postLogin = derivePostLoginRedirect(derivedBase, c, result.returnTo);
      if (postLogin === null) {
        throw new AramoError(
          'INTERNAL_ERROR',
          'Post-login redirect not configured',
          500,
          { requestId, details: { reason: 'post_login_redirect_missing' } },
        );
      }
      // Apple Go-Live A1 L-4 proof (a) — the attach outcome rides on the landing
      // URL (`linked=<idp>` or `link_refused=<reason>`), the browser analogue of
      // the native `link_refused` field.
      if (result.link !== undefined) {
        const landing = new URL(postLogin);
        if (result.link.linked !== undefined) landing.searchParams.set('linked', result.link.linked);
        if (result.link.refused !== undefined) landing.searchParams.set('link_refused', result.link.refused);
        res.redirect(302, landing.toString());
        return;
      }
      res.redirect(302, postLogin);
      return;
    }
    // Apple Go-Live R-5 (web) — no account for this verified identity under the
    // signup intent: hand the email and shared name to the Personal signup page in
    // the URL FRAGMENT (never sent to a server, never logged). No cookie is set.
    if (result.kind === 'signup_handoff') {
      const base = resolvePublicBaseUrl(derivedBase);
      if (base === null) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Identity not provisioned', 403, {
          requestId,
          details: { reason: 'user_not_provisioned' },
        });
      }
      const url = new URL('/signup/personal', base);
      url.hash = `apple=${encodeSignupHandoff(result)}`;
      res.redirect(302, url.toString());
      return;
    }
    // Apple Go-Live A1 L-4 path 1 — back to the page that started "Add <provider>".
    if (result.kind === 'linked' || result.kind === 'link_refused') {
      const base = resolvePublicBaseUrl(derivedBase);
      if (base === null) {
        if (result.kind === 'linked') {
          res.status(200).json({ linked: true, idp: result.idp });
          return;
        }
        throw new AramoError('VALIDATION_ERROR', 'Sign-in method not added', 409, {
          requestId,
          details: { reason: result.reason },
        });
      }
      const path = result.returnTo ?? defaultPostLoginPath(c);
      res.redirect(
        302,
        result.kind === 'linked'
          ? withQueryParam(base, path, 'linked', result.idp)
          : withQueryParam(base, path, 'link_error', result.reason),
      );
      return;
    }
    // IC-2 PR-4 (Amendment A1 §2 item 2): the 409 TENANT_SELECTION_REQUIRED
    // branch is RETIRED (the code stays registered as COMPATIBILITY_RESERVED).
    if (result.kind === 'validation_error') {
      const details: Record<string, unknown> = { reason: result.reason };
      if (result.cognitoError !== undefined) {
        details.cognito_error = result.cognitoError;
      }
      if (result.cognitoErrorDescription !== undefined) {
        details.cognito_error_description = result.cognitoErrorDescription;
      }
      return this.redirectCallbackErrorOrJson(
        res,
        derivedBase,
        c,
        new AramoError(
          'VALIDATION_ERROR',
          'Callback validation failed',
          400,
          { requestId, details },
        ),
      );
    }
    if (result.kind === 'auth_error') {
      // §5 Auth-Hardening D2 P4: user/config-class failures map to a clean
      // 4xx with details.reason (debuggable first login), not a blank 500.
      //   - token-content rejections (email_not_verified, missing_email,
      //     missing_sub, wrong_token_use) → 401 INVALID_TOKEN.
      //   - no_active_tenant → 403 TENANT_ACCESS_DENIED; IC-2 PR-4 maps the
      //     host-binding denials (host_tenant_mismatch,
      //     host_class_consumer_mismatch, host_unbound) and the defensive
      //     tenant_resolution_ambiguous to the SAME existing code (F-5) —
      //     the response names no foreign tenant.
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
      // Apple Go-Live A1 L-2 — a pending link was written: its handle and provider
      // ride ONLY in the /login URL fragment, never in the query or the JSON body.
      const linkFragment = result.link !== undefined ? pendingLinkFragment(result.link) : undefined;
      if (TOKEN_REASONS.has(result.reason)) {
        return this.redirectCallbackErrorOrJson(
          res,
          derivedBase,
          c,
          new AramoError('INVALID_TOKEN', 'IdP token rejected', 401, {
            requestId,
            details,
          }),
        );
      }
      if (TENANT_ACCESS_DENIED_REASONS.has(result.reason)) {
        return this.redirectCallbackErrorOrJson(
          res,
          derivedBase,
          c,
          new AramoError(
            'TENANT_ACCESS_DENIED',
            result.reason === 'no_active_tenant'
              ? 'No active tenant membership'
              : 'Tenant access denied for this host',
            403,
            { requestId, details },
          ),
          linkFragment,
        );
      }
      // Platform-Console Increment-2 PR-1 (workstream E) — tenant lifecycle
      // mint-gate denials (tenant-consumer only). Typed 403s so the tenant
      // console can render the suspended/closed UX distinctly.
      if (result.reason === 'tenant_suspended') {
        return this.redirectCallbackErrorOrJson(
          res,
          derivedBase,
          c,
          new AramoError('TENANT_SUSPENDED', 'Tenant is suspended', 403, {
            requestId,
            details,
          }),
        );
      }
      if (result.reason === 'tenant_closed') {
        return this.redirectCallbackErrorOrJson(
          res,
          derivedBase,
          c,
          new AramoError('TENANT_CLOSED', 'Tenant is closed', 403, {
            requestId,
            details,
          }),
        );
      }
      // IC-2 PR-6 — the tenant is not entitled to the consumer's product: the
      // EXISTING entitlement refusal code (EntitlementGuard parity), no tenant or
      // capability inventory disclosed beyond the reason.
      if (result.reason === 'consumer_not_entitled') {
        return this.redirectCallbackErrorOrJson(
          res,
          derivedBase,
          c,
          new AramoError(
            'TENANT_CAPABILITY_NOT_ENTITLED',
            'Tenant not entitled to this product',
            403,
            { requestId, details },
          ),
        );
      }
      return this.redirectCallbackErrorOrJson(
        res,
        derivedBase,
        c,
        new AramoError(
          'INSUFFICIENT_PERMISSIONS',
          'Identity not provisioned',
          403,
          { requestId, details },
        ),
        linkFragment,
      );
    }
    // internal_error
    return this.redirectCallbackErrorOrJson(
      res,
      derivedBase,
      c,
      new AramoError('INTERNAL_ERROR', 'Callback failed', 500, {
        requestId,
        details: { reason: result.reason },
      }),
    );
  }

  // Inc-3 PR-3.5 (Workstream A) — a callback error becomes a browser NAVIGATION
  // (302 → ${base}/login?error=CODE) so ats-web / platform-web can render a
  // humane page instead of raw JSON filling the browser (the Inc-1 lived
  // experience). Response-SHAPE only: the AramoError's code / reason / status
  // are byte-identical to before, and the gate logic that produced it is
  // untouched — this changes the content-type of the answer, not any decision.
  //
  // SECURITY (PR-3.1 §2 invariant, verbatim): the redirect base comes ONLY from
  // a validated derived base or the env chain (resolvePublicBaseUrl); a raw Host
  // NEVER reaches the redirect. If no base resolves, the JSON response remains
  // the final fallback (we re-throw) — never a redirect improvised from an
  // unvalidated host. The path is the fixed literal `/login`; `error` is a code
  // from the closed ErrorCode registry; `reason` (VALIDATION_ERROR subcodes
  // only) is our own detail — no request input reaches the redirect target.
  private redirectCallbackErrorOrJson(
    res: Response,
    derivedBase: string | null,
    consumer: string,
    err: AramoError,
    // Apple Go-Live A1 L-2 — `link=<handle>&idp=<idp>`, set as the URL fragment.
    linkFragment?: string,
  ): void {
    const base = resolvePublicBaseUrl(derivedBase);
    if (base === null) {
      throw err; // no validated base → JSON fallback (invariant honored)
    }
    const url = new URL('/login', base);
    url.searchParams.set('error', err.code);
    // AUTH-SIGNIN-1 §3.1.3 — name the consumer so the sign-in page's "Try
    // again" restarts the right one (a host serves several consumers' /login).
    url.searchParams.set('consumer', consumer);
    // AUTH-SIGNIN-1 — the provider-policy denials carry their reason so the page
    // can say which provider the organization uses (the caller has already
    // completed IdP sign-in; no account-existence oracle).
    const deniedReason = (err.context.details as { reason?: unknown } | undefined)?.reason;
    if (err.code === 'TENANT_ACCESS_DENIED' && (deniedReason === 'idp_not_permitted_for_tenant' || deniedReason === 'idp_identity_conflict')) {
      url.searchParams.set('reason', deniedReason);
    }
    if (err.code === 'VALIDATION_ERROR') {
      const reason = (err.context.details as { reason?: unknown } | undefined)
        ?.reason;
      if (typeof reason === 'string') {
        url.searchParams.set('reason', reason);
      }
    }
    // Apple Go-Live A1 L-2 — with a pending link the page needs the reason
    // (user_not_provisioned → path 2, idp_identity_conflict → path 3).
    if (linkFragment !== undefined) {
      if (deniedReason === 'user_not_provisioned' || deniedReason === 'idp_identity_conflict') {
        url.searchParams.set('reason', deniedReason);
      }
      url.hash = linkFragment;
    }
    res.redirect(302, url.toString());
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
    const refreshCookie = readCookie(req, refreshCookieName(c), LEGACY_REFRESH_COOKIE);
    // IC-2 PR-5 — the refresh request's host class/context ride to the
    // orchestrator (bound against the STORED token tenant; F-5/F-6 posture).
    const { hostClass, contextId } = await this.hostBase.resolve(requestHost(req));
    const result = await this.refreshOrch.handleRefresh({
      consumer: c,
      refreshCookie,
      hostClass,
      contextId,
    });
    if (result.kind === 'success') {
      setAccessCookie(res, c, result.accessJwt);
      setRefreshCookie(res, c, result.refreshTokenPlaintext);
      // D-ORG-4 upgrade transition: a jar minted BEFORE the consumer-suffixed
      // names (legacy `aramo_refresh_token`) is migrated by this re-mint — the
      // rotated token now lives only under the consumer name, so the legacy
      // pair is retired here (it would otherwise linger holding a consumed token).
      if (req.cookies?.[refreshCookieName(c)] === undefined && req.cookies?.[LEGACY_REFRESH_COOKIE] !== undefined) {
        res.cookie(LEGACY_ACCESS_COOKIE, '', { httpOnly: true, secure: shouldSetSecure(), sameSite: 'lax', path: '/', maxAge: 0 });
        res.cookie(LEGACY_REFRESH_COOKIE, '', { httpOnly: true, secure: shouldSetSecure(), sameSite: 'strict', path: '/auth', maxAge: 0 });
      }
      res.status(200).end();
      return;
    }
    if (result.kind === 'token_invalid') {
      // Clear BOTH cookies on every 401 path per §8.3.
      clearAccessCookie(res, c);
      clearRefreshCookie(res, c);
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
    const refreshCookie = readCookie(req, refreshCookieName(c), LEGACY_REFRESH_COOKIE);
    if (refreshCookie !== undefined && refreshCookie.length > 0) {
      const tokenHash = sha256Base64Url(refreshCookie);
      const found = await this.refreshTokens.findByHash({ token_hash: tokenHash });
      if (found !== null && found.consumer_type === c) {
        // IC-2 PR-5 — reconcile the logout host against the token's tenant. A
        // mismatch NEVER strands the user: the presented token is revoked and
        // the host-only cookies are cleared regardless (a token presented on
        // the wrong host is the more suspicious case, so killing it is the
        // safe outcome). The audit reason records the mismatch; nothing in the
        // 204 discloses any tenant. Cognito logout (GET) is untouched (HF3).
        const { hostClass, contextId } = await this.hostBase.resolve(requestHost(req));
        const binding = evaluateSessionHostBinding({
          host_class: hostClass,
          context_id: contextId,
          consumer: c,
          resolved_context_id: found.tenant_id,
          allow_unbound: allowUnboundHost(),
        });
        let reason = 'logout';
        if (!binding.ok) {
          // An unbound/dev host is diagnostic noise, not a mismatch: keep the
          // plain reason. A genuine tenant/class mismatch is recorded.
          if (binding.reason !== 'host_unbound') reason = `logout_${binding.reason}`;
          this.logger.warn(
            JSON.stringify({
              event: 'auth.host_binding',
              stage: 'logout',
              mode: readHostBindingMode(),
              outcome: binding.reason,
              consumer: c,
              host_class: hostClass ?? null,
            }),
          );
        }
        await this.refreshTokens.revoke({ id: found.id });
        // session.revoked — emitted by AUTH via AuditSink (PR-4 §7.4 Ruling 3).
        await this.auditSink.record({
          event_type: 'identity.session.revoked',
          actor_id: found.user_id,
          context_id: found.tenant_id,
          subject_id: found.user_id,
          payload: { reason },
        });
      }
    }
    clearAccessCookie(res, c);
    clearRefreshCookie(res, c);
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
    // The sign-out return URL. PR-3.1 §3d.3: a VALIDATED host derives
    // ${derivedBase}${AUTH_SIGNOUT_PATH ?? '/'}; an unvalidated host falls back
    // to the legacy registered AUTH_COGNITO_SIGNOUT_REDIRECT (config, never
    // input). The §2 invariant holds: deriveSignoutRedirect returns the raw host
    // NEVER — only a validated-host base or the registered env — so this can't
    // become an open-redirect. Throws when neither resolves.
    const { derivedBase } = await this.hostBase.resolve(req.get('host'));
    const signOutRedirect = deriveSignoutRedirect(derivedBase);
    if (signOutRedirect === null) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'Post-logout redirect not configured',
        500,
        { requestId, details: { reason: 'signout_redirect_missing' } },
      );
    }
    // D-ORG-4 — GLOBAL sign-out semantics: this redirect ends the Cognito (SSO)
    // session for the browser, so EVERY consumer session on this host is revoked
    // and cleared first (the refresh cookies all live under path '/auth', so each
    // consumer's refresh token is visible here). POST /auth/{consumer}/logout keeps
    // its per-consumer (single product) semantics.
    await this.revokeAllConsumerSessions(req, res);
    const url = new URL(`https://${domain}/logout`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('logout_uri', signOutRedirect);
    res.redirect(302, url.toString());
  }

  // Revoke + clear every consumer session cookie present on the request (plus the
  // legacy unsuffixed cookies). Best-effort per consumer: a missing or already-
  // revoked token is skipped; the cookies are always cleared.
  private async revokeAllConsumerSessions(req: RequestWithCookies, res: Response): Promise<void> {
    // Cookie-less call (already signed out) → idempotent no-op: nothing to revoke,
    // nothing to clear (the Cognito redirect still happens).
    const jar: Record<string, unknown> = req.cookies ?? {};
    const anyPresent = Object.entries(jar).some(
      ([name, value]) =>
        typeof value === 'string' && value.length > 0 && (name.startsWith(LEGACY_ACCESS_COOKIE) || name.startsWith(LEGACY_REFRESH_COOKIE)),
    );
    if (!anyPresent) return;
    const seen = new Set<string>();
    for (const { consumer, name } of allRefreshCookieNames()) {
      const plain = req.cookies?.[name];
      if (plain === undefined || plain.length === 0 || seen.has(plain)) continue;
      seen.add(plain);
      await this.revokeRefreshPlaintext(plain, consumer, 'logout_all');
    }
    const legacy = req.cookies?.[LEGACY_REFRESH_COOKIE];
    if (legacy !== undefined && legacy.length > 0 && !seen.has(legacy)) {
      await this.revokeRefreshPlaintext(legacy, null, 'logout_all');
    }
    for (const consumer of CONSUMER_TYPES) {
      clearAccessCookie(res, consumer);
      clearRefreshCookie(res, consumer);
    }
  }

  private async revokeRefreshPlaintext(plain: string, consumer: ConsumerType | null, reason: string): Promise<void> {
    const found = await this.refreshTokens.findByHash({ token_hash: sha256Base64Url(plain) });
    if (found === null) return;
    if (consumer !== null && found.consumer_type !== consumer) return;
    await this.refreshTokens.revoke({ id: found.id });
    await this.auditSink.record({
      event_type: 'identity.session.revoked',
      actor_id: found.user_id,
      context_id: found.tenant_id,
      subject_id: found.user_id,
      payload: { reason, consumer: found.consumer_type },
    });
  }

  // §8.5 — GET /auth/{consumer}/session
  @Get('session')
  async session(
    @Param('consumer') consumer: string,
    @Req() req: RequestWithCookies,
  ): Promise<SessionResponseDto> {
    const requestId = req.requestId ?? 'unknown';
    const c = parseConsumer(consumer, requestId);
    const cookie = readCookie(req, accessCookieName(c), LEGACY_ACCESS_COOKIE);
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
    // AUTH-SIGNIN-1 Amendment M-A1 — a native (Bearer-only) token is never a
    // browser session cookie; refused here so the two credential families stay
    // apart. Browser tokens carry no `client` claim (unchanged path).
    if (payload.client !== undefined) {
      throw new AramoError(
        'INVALID_TOKEN',
        'Native token presented as a browser session',
        401,
        { requestId, details: { reason: 'native_token_on_browser_route' } },
      );
    }
    // IC-2 PR-5 — /session host/tenant binding (closes the PR-4 residual gap
    // G-1). The token's tenant is compared with the request host under the
    // PR-4 session-surface policy BEFORE any authorization detail is returned:
    // enforce → 403 TENANT_ACCESS_DENIED (details.reason only, no tenant named);
    // log → structured diagnostic, outcome unchanged.
    const { hostClass, contextId } = await this.hostBase.resolve(requestHost(req));
    const binding = evaluateSessionHostBinding({
      host_class: hostClass,
      context_id: contextId,
      consumer: payload.consumer_type,
      resolved_context_id: payload.tenant_id,
      allow_unbound: allowUnboundHost(),
    });
    if (!binding.ok) {
      const mode = readHostBindingMode();
      this.logger.warn(
        JSON.stringify({
          event: 'auth.host_binding',
          stage: 'session',
          mode,
          outcome: binding.reason,
          consumer: payload.consumer_type,
          host_class: hostClass ?? null,
        }),
      );
      if (mode === 'enforce') {
        throw new AramoError(
          'TENANT_ACCESS_DENIED',
          'Tenant access denied for this host',
          403,
          { requestId, details: { reason: binding.reason } },
        );
      }
    }
    // HF-AUTH-1 — resolve the effective scopes server-side for the response body
    // (the compact cookie carries none). Same resolver as the api guard: portal
    // returns its fixed set, a bumped authz_version is `stale` (401), an unprovable
    // authorization is `unresolvable` (401, fail closed).
    const resolution = await this.authzResolver.resolve({
      tenant_id: payload.tenant_id,
      principal_id: payload.sub,
      consumer_type: payload.consumer_type,
      actor_kind: 'user',
      token_authz_version: payload.authz_version,
      ...(payload.site_id !== undefined ? { site_id: payload.site_id } : {}),
    });
    if (resolution.status !== 'ok') {
      throw new AramoError(
        'INVALID_TOKEN',
        'Access token authorization not resolvable',
        401,
        {
          requestId,
          details: {
            reason: resolution.status === 'stale' ? 'authz_version_stale' : 'authz_unresolvable',
          },
        },
      );
    }
    return {
      sub: payload.sub,
      consumer_type: payload.consumer_type,
      tenant_id: payload.tenant_id,
      scopes: resolution.scopes,
      iat: payload.iat,
      exp: payload.exp,
    };
  }
}
