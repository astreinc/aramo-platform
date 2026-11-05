import { Logger } from '@nestjs/common';
import { type JWTVerifyGetKey, SignJWT, createRemoteJWKSet, importPKCS8, jwtVerify } from 'jose';

import { BillingProviderUnavailableError, type ProviderSubscriptionState, type VerifiedBillingEvent } from '../billing-provider.port.js';

import type { GooglePlayConfig } from './store-billing.config.js';
import { StoreVerificationError, type StoreFetch, type StoreSubscriptionPort } from './store-billing.port.js';
import { type PlaySubscriptionPurchaseV2, playSubscriptionState } from './store-state.js';

// Aramo Sign Mobile M-A12 W1-G items 3–4 (LOCKED) — the Google Play adapter.
//   retrieveSubscription  Android Publisher purchases.subscriptionsv2.get for the configured package
//                         (the AUTHORITATIVE state), with a service-account access token: an RS256 JWT
//                         signed with jose (scope androidpublisher) exchanged at Google's OAuth token
//                         endpoint (the M-A11 native-integrity pattern); cached until shortly before expiry
//   acknowledge           purchases.subscriptions.acknowledge (a purchase not acknowledged within three
//                         days is refunded by Play)
//   verifyPush            a Real-time Developer Notification pushed by Pub/Sub: the OIDC bearer is
//                         verified (Google's keys, issuer accounts.google.com, audience =
//                         SIGN_GOOGLE_PLAY_RTDN_AUDIENCE, email = SIGN_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT,
//                         email_verified), then the message is reduced to a verified envelope
//                         (id = Pub/Sub messageId, ref = purchaseToken); the package must be ours
//   regionalPrices        the base-plan regional prices of a subscription product (the A1-3
//                         reconciliation report reads them; nothing is decided at runtime)
// Only reason codes and HTTP statuses are logged: never a token, a credential or a purchase token.

export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_OIDC_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

export interface PlayStoreRegionalPrice {
  country: string;
  currency: string;
  amount_minor: number;
}

/** Minor-unit exponent of the few zero / three-decimal currencies; every other currency is 2. */
const EXPONENT: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 2, TWD: 2, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };

/** A Google Money (units + nanos) in the currency's minor unit. */
export function googleMoneyMinor(price: { currencyCode?: string; units?: string | number; nanos?: number }): number | null {
  const currency = price.currencyCode ?? '';
  const units = Number(price.units ?? 0);
  const nanos = Number(price.nanos ?? 0);
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(units) || !Number.isFinite(nanos)) return null;
  const exp = EXPONENT[currency] ?? 2;
  return Math.round((units + nanos / 1e9) * 10 ** exp);
}

export class GooglePlayAdapter implements StoreSubscriptionPort {
  readonly provider = 'GOOGLE_PLAY' as const;
  private readonly log = new Logger(GooglePlayAdapter.name);
  private cached: { token: string; expires_at: number } | null = null;
  private readonly jwks: JWTVerifyGetKey;

  constructor(
    private readonly config: GooglePlayConfig | null,
    private readonly fetchImpl: StoreFetch = (url, init) => fetch(url, init),
    private readonly clock: () => number = () => Date.now(),
    jwks?: JWTVerifyGetKey,
    private readonly timeoutMs = 8000,
  ) {
    this.jwks = jwks ?? createRemoteJWKSet(new URL(GOOGLE_OIDC_JWKS_URL));
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  /** RTDN is accepted only with both the audience and the push service account configured. */
  pushConfigured(): boolean {
    return this.config !== null && this.config.rtdn_audience !== null && this.config.rtdn_service_account !== null;
  }

  get packageName(): string | null {
    return this.config?.package_name ?? null;
  }

  private cfg(): GooglePlayConfig {
    if (this.config === null) throw new BillingProviderUnavailableError('google play billing is not configured', false);
    return this.config;
  }

  async retrieveSubscription(purchase_token: string): Promise<ProviderSubscriptionState> {
    return playSubscriptionState(purchase_token, await this.getPurchase(purchase_token));
  }

  /** subscriptionsv2.get (raw), with the acknowledgement state. */
  async getPurchase(purchase_token: string): Promise<PlaySubscriptionPurchaseV2> {
    const c = this.cfg();
    if (typeof purchase_token !== 'string' || purchase_token.length === 0 || purchase_token.length > 4096) throw new StoreVerificationError('malformed');
    const url = `${PUBLISHER}/${encodeURIComponent(c.package_name)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchase_token)}`;
    const res = await this.call(url, 'GET');
    // 400 / 404 / 410: the token is not a purchase of this package (wrong package, unknown, expired long ago).
    if (res.status === 400 || res.status === 404 || res.status === 410) throw new StoreVerificationError('unknown_purchase');
    if (!res.ok) throw this.unavailable(res.status);
    return (await res.json()) as PlaySubscriptionPurchaseV2;
  }

  /** purchases.subscriptions.acknowledge (idempotent at Play). */
  async acknowledge(product_id: string, purchase_token: string): Promise<void> {
    const c = this.cfg();
    const url = `${PUBLISHER}/${encodeURIComponent(c.package_name)}/purchases/subscriptions/${encodeURIComponent(product_id)}/tokens/${encodeURIComponent(purchase_token)}:acknowledge`;
    const res = await this.call(url, 'POST', '{}');
    if (!res.ok) throw this.unavailable(res.status);
  }

  /** The base-plan regional prices of one subscription product (monetization.subscriptions.get). */
  async regionalPrices(product_id: string): Promise<PlayStoreRegionalPrice[]> {
    const c = this.cfg();
    const res = await this.call(`${PUBLISHER}/${encodeURIComponent(c.package_name)}/subscriptions/${encodeURIComponent(product_id)}`, 'GET');
    if (res.status === 404) return [];
    if (!res.ok) throw this.unavailable(res.status);
    const body = (await res.json()) as { basePlans?: { regionalConfigs?: { regionCode?: string; price?: { currencyCode?: string; units?: string; nanos?: number } }[] }[] };
    const out: PlayStoreRegionalPrice[] = [];
    for (const bp of body.basePlans ?? []) {
      for (const rc of bp.regionalConfigs ?? []) {
        const minor = rc.price === undefined ? null : googleMoneyMinor(rc.price);
        if (typeof rc.regionCode === 'string' && rc.price?.currencyCode !== undefined && minor !== null) out.push({ country: rc.regionCode, currency: rc.price.currencyCode, amount_minor: minor });
      }
    }
    return out;
  }

  /**
   * A Pub/Sub push of a Real-time Developer Notification → a verified event envelope, or null for
   * a notification that carries no subscription (test or one-time product). Throws
   * StoreVerificationError when the bearer or the message is not authentic or not ours.
   */
  async verifyPush(authorization: string | undefined, body: unknown): Promise<VerifiedBillingEvent | null> {
    const c = this.cfg();
    if (c.rtdn_audience === null || c.rtdn_service_account === null) throw new StoreVerificationError('push_not_configured');
    const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(authorization ?? '');
    if (m === null) throw new StoreVerificationError('push_token_missing');
    try {
      const { payload } = await jwtVerify(m[1] as string, this.jwks, {
        issuer: ['accounts.google.com', 'https://accounts.google.com'],
        audience: c.rtdn_audience,
        currentDate: new Date(this.clock()),
      });
      if (payload['email'] !== c.rtdn_service_account || payload['email_verified'] !== true) throw new StoreVerificationError('push_wrong_account');
    } catch (e) {
      if (e instanceof StoreVerificationError) throw e;
      throw new StoreVerificationError('push_token_invalid');
    }
    const msg = (typeof body === 'object' && body !== null ? (body as { message?: { data?: unknown; messageId?: unknown; publishTime?: unknown } }).message : undefined) ?? undefined;
    if (msg === undefined || typeof msg.data !== 'string' || typeof msg.messageId !== 'string') throw new StoreVerificationError('push_malformed');
    let n: { packageName?: string; eventTimeMillis?: string; subscriptionNotification?: { notificationType?: number; purchaseToken?: string }; voidedPurchaseNotification?: { purchaseToken?: string; productType?: number } };
    try {
      n = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf8')) as typeof n;
    } catch {
      throw new StoreVerificationError('push_malformed');
    }
    if (n.packageName !== c.package_name) throw new StoreVerificationError('wrong_package');
    const created = new Date(Number(n.eventTimeMillis ?? this.clock()));
    const sub = n.subscriptionNotification;
    // productType 1 = subscription.
    const voided = n.voidedPurchaseNotification?.productType === 1 ? n.voidedPurchaseNotification : undefined;
    const token = sub?.purchaseToken ?? voided?.purchaseToken ?? null;
    if (token === null) return null;
    return {
      provider: 'GOOGLE_PLAY',
      id: msg.messageId,
      type: sub !== undefined ? `subscription.${String(sub.notificationType ?? 'unknown')}` : 'voided_purchase',
      created: Number.isFinite(created.getTime()) ? created : new Date(this.clock()),
      subscription_ref: token,
    };
  }

  private unavailable(status: number): BillingProviderUnavailableError {
    this.log.warn(`google play api unavailable: http_${status}`);
    if (status === 401 || status === 403) this.cached = null;
    return new BillingProviderUnavailableError(`google play api http ${status}`, status === 429 || status >= 500);
  }

  private async call(url: string, method: 'GET' | 'POST', body?: string): Promise<Awaited<ReturnType<StoreFetch>>> {
    const token = await this.accessToken();
    try {
      return await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      this.log.warn(`google play api unavailable: ${(e as Error).name}`);
      throw new BillingProviderUnavailableError('google play api unreachable');
    }
  }

  private async accessToken(): Promise<string> {
    const c = this.cfg();
    const now = this.clock();
    if (this.cached !== null && this.cached.expires_at > now) return this.cached.token;
    try {
      const key = await importPKCS8(c.credentials.private_key, 'RS256');
      const iat = Math.floor(now / 1000);
      const assertion = await new SignJWT({ scope: ANDROID_PUBLISHER_SCOPE })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(c.credentials.private_key_id === undefined ? {} : { kid: c.credentials.private_key_id }) })
        .setIssuer(c.credentials.client_email)
        .setAudience(GOOGLE_OAUTH_TOKEN_URL)
        .setIssuedAt(iat)
        .setExpirationTime(iat + 3600)
        .sign(key);
      const res = await this.fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const out = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
      const ttl = typeof out.expires_in === 'number' ? out.expires_in : 0;
      if (typeof out.access_token !== 'string' || out.access_token === '' || ttl <= 0) throw new Error('token_response_malformed');
      this.cached = { token: out.access_token, expires_at: now + Math.max(0, ttl - 60) * 1000 };
      return out.access_token;
    } catch (e) {
      this.log.warn(`google play credential unavailable: ${(e as Error).message.slice(0, 40)}`);
      throw new BillingProviderUnavailableError('google play credential unavailable');
    }
  }
}
