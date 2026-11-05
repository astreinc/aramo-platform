import { Logger } from '@nestjs/common';
import { SignJWT, importPKCS8 } from 'jose';

import { BillingProviderUnavailableError, type ProviderSubscriptionState, type VerifiedBillingEvent } from '../billing-provider.port.js';

import { AppleJwsError, type AppleJwsVerifier, type AppleNotificationPayload, type AppleRenewalInfoPayload, type AppleTransactionPayload } from './apple-jws.verifier.js';
import type { AppleStoreConfig } from './store-billing.config.js';
import { StoreVerificationError, type StoreFetch, type StoreSubscriptionPort } from './store-billing.port.js';
import { appleSubscriptionState } from './store-state.js';

// Aramo Sign Mobile M-A12 W1-G items 3–4 (LOCKED) — the App Store adapter.
//   verifyTransaction    a StoreKit 2 signed transaction from the app: the x5c chain to Apple Root
//                        CA G3, the bundle id and the environment (AppleJwsVerifier + the checks here)
//   retrieveSubscription the AUTHORITATIVE state: App Store Server API "Get All Subscription Statuses"
//                        (GET /inApps/v1/subscriptions/{transactionId}) with an ES256 JWT signed by the
//                        In-App Purchase key; every signed transaction / renewal info in the answer is
//                        verified again before it is read
//   verifyNotification   App Store Server Notifications v2: the signedPayload verified, then reduced to
//                        a verified event envelope (id = notificationUUID, ref = originalTransactionId);
//                        the payload's state is never applied (the inbox re-fetches)
// Only reason codes and HTTP statuses are logged: never a JWS, a token or the key.

export const APPLE_SERVER_API_BASE: Record<'Sandbox' | 'Production', string> = {
  Production: 'https://api.storekit.itunes.apple.com',
  Sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
};

export interface AppleVerifiedTransaction {
  original_transaction_id: string;
  transaction_id: string;
  product_id: string;
  app_account_token: string | null;
  environment: 'Sandbox' | 'Production';
}

export class AppleAppStoreAdapter implements StoreSubscriptionPort {
  readonly provider = 'APP_STORE' as const;
  private readonly log = new Logger(AppleAppStoreAdapter.name);

  constructor(
    private readonly config: AppleStoreConfig | null,
    private readonly verifier: AppleJwsVerifier,
    private readonly fetchImpl: StoreFetch = (url, init) => fetch(url, init),
    private readonly clock: () => number = () => Date.now(),
    private readonly timeoutMs = 8000,
  ) {}

  isConfigured(): boolean {
    return this.config !== null;
  }

  private cfg(): AppleStoreConfig {
    if (this.config === null) throw new BillingProviderUnavailableError('app store billing is not configured', false);
    return this.config;
  }

  /** Bundle and environment of a decoded payload must be ours (fail closed). */
  private assertOurs(p: { bundleId?: string; environment?: string }): void {
    const c = this.cfg();
    if (p.bundleId !== c.bundle_id) throw new StoreVerificationError('wrong_bundle');
    if (p.environment !== c.environment) throw new StoreVerificationError('wrong_environment');
  }

  private async verified<T>(jws: string): Promise<T> {
    try {
      return await this.verifier.verify<T>(jws);
    } catch (e) {
      if (e instanceof AppleJwsError) throw new StoreVerificationError(`jws_${e.reason}`);
      throw e;
    }
  }

  /** A signed transaction from the app (StoreKit 2 jwsRepresentation). */
  async verifyTransaction(signed_transaction: string): Promise<AppleVerifiedTransaction> {
    const t = await this.verified<AppleTransactionPayload>(signed_transaction);
    this.assertOurs(t);
    if (typeof t.originalTransactionId !== 'string' || typeof t.transactionId !== 'string' || typeof t.productId !== 'string') throw new StoreVerificationError('malformed');
    return {
      original_transaction_id: t.originalTransactionId,
      transaction_id: t.transactionId,
      product_id: t.productId,
      app_account_token: typeof t.appAccountToken === 'string' ? t.appAccountToken.toLowerCase() : null,
      environment: t.environment as 'Sandbox' | 'Production',
    };
  }

  /** App Store Server Notifications v2 → a verified event envelope (null: not a subscription event). */
  async verifyNotification(signedPayload: string): Promise<VerifiedBillingEvent> {
    const n = await this.verified<AppleNotificationPayload>(signedPayload);
    const data = n.data ?? {};
    this.assertOurs({ bundleId: data.bundleId, environment: data.environment });
    if (typeof n.notificationUUID !== 'string' || typeof n.notificationType !== 'string') throw new StoreVerificationError('malformed');
    let ref: string | null = null;
    if (typeof data.signedTransactionInfo === 'string') {
      const t = await this.verified<AppleTransactionPayload>(data.signedTransactionInfo);
      this.assertOurs(t);
      ref = typeof t.originalTransactionId === 'string' ? t.originalTransactionId : null;
    }
    return {
      provider: 'APP_STORE',
      id: n.notificationUUID,
      type: n.subtype !== undefined ? `${n.notificationType}.${n.subtype}` : n.notificationType,
      created: typeof n.signedDate === 'number' ? new Date(n.signedDate) : new Date(this.clock()),
      subscription_ref: ref,
    };
  }

  /** Re-fetch the subscription from the App Store Server API (authoritative). */
  async retrieveSubscription(original_transaction_id: string): Promise<ProviderSubscriptionState> {
    const c = this.cfg();
    const url = `${APPLE_SERVER_API_BASE[c.environment]}/inApps/v1/subscriptions/${encodeURIComponent(original_transaction_id)}`;
    let res: Awaited<ReturnType<StoreFetch>>;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${await this.apiToken()}` }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      this.log.warn(`app store server api unavailable: ${(e as Error).name}`);
      throw new BillingProviderUnavailableError('app store server api unreachable');
    }
    if (res.status === 404 || res.status === 400) throw new StoreVerificationError('unknown_transaction');
    if (!res.ok) {
      this.log.warn(`app store server api unavailable: http_${res.status}`);
      throw new BillingProviderUnavailableError(`app store server api http ${res.status}`, res.status === 429 || res.status >= 500);
    }
    const body = (await res.json()) as { bundleId?: string; environment?: string; data?: { lastTransactions?: { originalTransactionId?: string; status?: number; signedTransactionInfo?: string; signedRenewalInfo?: string }[] }[] };
    this.assertOurs(body);
    const last = (body.data ?? []).flatMap((g) => g.lastTransactions ?? []).find((t) => t.originalTransactionId === original_transaction_id);
    if (last === undefined || typeof last.signedTransactionInfo !== 'string' || typeof last.status !== 'number') throw new StoreVerificationError('unknown_transaction');
    const tx = await this.verified<AppleTransactionPayload>(last.signedTransactionInfo);
    this.assertOurs(tx);
    if (tx.originalTransactionId !== original_transaction_id) throw new StoreVerificationError('malformed');
    const renewal = typeof last.signedRenewalInfo === 'string' ? await this.verified<AppleRenewalInfoPayload>(last.signedRenewalInfo) : null;
    return appleSubscriptionState(last.status, tx, renewal);
  }

  /** The App Store Server API bearer: ES256, kid = key id, iss = issuer, aud appstoreconnect-v1, bid. */
  private async apiToken(): Promise<string> {
    const c = this.cfg();
    try {
      const key = await importPKCS8(c.private_key_pem, 'ES256');
      const iat = Math.floor(this.clock() / 1000);
      return await new SignJWT({ bid: c.bundle_id })
        .setProtectedHeader({ alg: 'ES256', kid: c.key_id, typ: 'JWT' })
        .setIssuer(c.issuer_id)
        .setAudience('appstoreconnect-v1')
        .setIssuedAt(iat)
        .setExpirationTime(iat + 600)
        .sign(key);
    } catch (e) {
      this.log.warn(`app store api credential unavailable: ${(e as Error).name}`);
      throw new BillingProviderUnavailableError('app store api credential unavailable', false);
    }
  }
}
