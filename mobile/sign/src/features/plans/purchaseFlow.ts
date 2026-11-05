// M-A12 W1-G.3 — buying and restoring through the platform store (contract §4). The
// server is authoritative; the app only carries the store's proof to it:
//   1. POST /v1/sign/billing/store/intent  { platform, product_id } → { intent_id, app_account_token }
//   2. the native purchase sheet, with app_account_token as iOS appAccountToken /
//      Android obfuscatedAccountId
//   3. POST /v1/sign/billing/store/verify  { platform, product_id, intent_id,
//      signed_transaction (iOS JWS) | purchase_token (Android) } → the account view
//   4. ONLY after the server accepted it: finish (iOS) / complete (Android) the transaction
//   5. the caller refreshes the account
// Restore: the store's current subscriptions → POST /v1/sign/billing/store/restore.
// Nothing here logs or stores a receipt, JWS or purchase token.
import { isApiError } from '../../api/errors';
import type {
  StoreIntent,
  StoreIntentRequest,
  StorePlatform,
  StoreRestoreRequest,
  StoreVerifyRequest,
} from '../../api/m-a12-contract-types';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { blockCopy, PLANS_COPY, type Account, type Plan } from './plansModel';
import type { StorePort, StoreProductInfo, StorePurchase } from './storePort';

export interface StoreBillingApi {
  plans(): Promise<Plan[]>;
  intent(body: StoreIntentRequest): Promise<StoreIntent>;
  verify(body: StoreVerifyRequest): Promise<Account>;
  restore(body: StoreRestoreRequest): Promise<Account>;
}

export function createStoreBillingApi(workspace: WorkspaceClient): StoreBillingApi {
  return {
    async plans() {
      const r = await workspace.call('/v1/sign/billing/plans', 'get', {});
      return (r.plans ?? []) as Plan[];
    },
    async intent(body) {
      const r = await workspace.request<StoreIntent>({ method: 'POST', path: '/v1/sign/billing/store/intent', body });
      return r.data;
    },
    async verify(body) {
      const r = await workspace.request<Account>({ method: 'POST', path: '/v1/sign/billing/store/verify', body });
      return r.data;
    },
    async restore(body) {
      const r = await workspace.request<Account>({ method: 'POST', path: '/v1/sign/billing/store/restore', body });
      return r.data;
    },
  };
}

export type PurchaseOutcome =
  | { readonly kind: 'purchased'; readonly account: Account }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'pending'; readonly message: string }
  /** The server refused (intent or verify), with the copy to show. */
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

function refusal(e: unknown, fallback: string): PurchaseOutcome {
  if (isApiError(e) && !e.isNetwork && (e.status === 403 || e.status === 409 || e.status === 422)) {
    return { kind: 'refused', message: blockCopy(e.reason || e.code, null) ?? fallback };
  }
  return { kind: 'failed', message: fallback };
}

function proof(platform: StorePlatform, p: StorePurchase): Pick<StoreVerifyRequest, 'signed_transaction' | 'purchase_token'> {
  return platform === 'ios' ? { signed_transaction: p.token } : { purchase_token: p.token };
}

export async function buy(
  deps: { readonly store: StorePort; readonly api: StoreBillingApi },
  product: StoreProductInfo,
): Promise<PurchaseOutcome> {
  const platform = deps.store.platform;
  let intent: StoreIntent;
  try {
    intent = await deps.api.intent({ platform, product_id: product.productId });
  } catch (e) {
    return refusal(e, PLANS_COPY.unavailable);
  }
  const r = await deps.store.purchase(product, intent.app_account_token);
  if (r.kind === 'cancelled') return { kind: 'cancelled' };
  if (r.kind === 'pending') return { kind: 'pending', message: PLANS_COPY.pending };
  if (r.kind === 'failed') return { kind: 'failed', message: PLANS_COPY.failed };
  let account: Account;
  try {
    account = await deps.api.verify({
      platform,
      product_id: product.productId,
      intent_id: intent.intent_id,
      ...proof(platform, r.purchase),
    });
  } catch (e) {
    // Not finished: the store keeps the transaction, so Restore (or the next launch)
    // can carry it to the server again.
    return refusal(e, PLANS_COPY.verifyFailed);
  }
  await deps.store.finish(r.purchase).catch(() => undefined);
  return { kind: 'purchased', account };
}

export type RestoreOutcome =
  | { readonly kind: 'restored'; readonly account: Account }
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string };

export async function restore(deps: { readonly store: StorePort; readonly api: StoreBillingApi }): Promise<RestoreOutcome> {
  const platform = deps.store.platform;
  let purchases: StorePurchase[];
  try {
    purchases = await deps.store.restore();
  } catch {
    return { kind: 'failed', message: PLANS_COPY.failed };
  }
  if (purchases.length === 0) return { kind: 'none' };
  const tokens = purchases.map((p) => p.token);
  let account: Account;
  try {
    account = await deps.api.restore(
      platform === 'ios' ? { platform, signed_transactions: tokens } : { platform, purchase_tokens: tokens },
    );
  } catch (e) {
    const r = refusal(e, PLANS_COPY.verifyFailed);
    return r.kind === 'refused' ? r : { kind: 'failed', message: PLANS_COPY.verifyFailed };
  }
  for (const p of purchases) await deps.store.finish(p).catch(() => undefined);
  return { kind: 'restored', account };
}
