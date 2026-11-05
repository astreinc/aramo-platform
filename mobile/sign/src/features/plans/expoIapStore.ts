// M-A12 W1-G — the StorePort over `expo-iap` (StoreKit 2 on iOS, Play Billing on Android;
// an Expo module, autolinked by prebuild like the other expo-* modules). The only file
// that imports the library. Purchase results arrive on the library's listeners; the
// adapter resolves the one purchase it started and never finishes a transaction by itself.
import {
  deepLinkToSubscriptions,
  endConnection,
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  type Purchase,
} from 'expo-iap';
import { Platform } from 'react-native';

import type { StorePort, StoreProductInfo, StorePurchase, StorePurchaseResult } from './storePort';

const PACKAGE = 'ai.aramo.sign';

function toStorePurchase(p: Purchase): StorePurchase | null {
  const token = p.purchaseToken ?? null;
  return token ? { productId: p.productId, token, handle: p } : null;
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function createExpoIapStore(): StorePort {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  let connected = false;
  return {
    platform,
    async connect() {
      if (connected) return true;
      connected = await initConnection().catch(() => false);
      return connected;
    },
    async disconnect() {
      if (!connected) return;
      connected = false;
      await endConnection().catch(() => undefined);
    },
    async products(productIds) {
      if (productIds.length === 0) return [];
      const out = (await fetchProducts({ skus: [...productIds], type: 'subs' })) ?? [];
      const list: StoreProductInfo[] = [];
      for (const raw of out as unknown[]) {
        const p = rec(raw);
        const id = typeof p['id'] === 'string' ? p['id'] : null;
        const price = typeof p['displayPrice'] === 'string' ? p['displayPrice'] : null;
        if (!id || !price) continue;
        const offers = Array.isArray(p['subscriptionOffers']) ? (p['subscriptionOffers'] as unknown[]).map(rec) : [];
        const token = offers.map((o) => o['offerTokenAndroid']).find((x): x is string => typeof x === 'string') ?? null;
        list.push({
          productId: id,
          displayPrice: price,
          currency: typeof p['currency'] === 'string' ? p['currency'] : null,
          offerToken: token,
        });
      }
      return list;
    },
    purchase(product, accountToken) {
      return new Promise<StorePurchaseResult>((resolve) => {
        let settled = false;
        const done = (r: StorePurchaseResult) => {
          if (settled) return;
          settled = true;
          updated.remove();
          failed.remove();
          resolve(r);
        };
        const updated = purchaseUpdatedListener((p: Purchase) => {
          if (p.productId !== product.productId) return;
          if (p.purchaseState === 'pending') return done({ kind: 'pending' });
          const sp = toStorePurchase(p);
          done(sp ? { kind: 'purchased', purchase: sp } : { kind: 'failed', code: 'no-token' });
        });
        const failed = purchaseErrorListener((e) => {
          const code = String(e.code ?? 'unknown');
          if (code === 'user-cancelled') done({ kind: 'cancelled' });
          else if (code === 'pending') done({ kind: 'pending' });
          else done({ kind: 'failed', code });
        });
        requestPurchase({
          type: 'subs',
          request: {
            apple: { sku: product.productId, appAccountToken: accountToken },
            google: {
              skus: [product.productId],
              obfuscatedAccountId: accountToken,
              ...(product.offerToken
                ? { subscriptionOffers: [{ sku: product.productId, offerToken: product.offerToken }] }
                : {}),
            },
          },
        })
          .then((r) => {
            const first = Array.isArray(r) ? r[0] : r;
            if (first && first.productId === product.productId) {
              if (first.purchaseState === 'pending') return done({ kind: 'pending' });
              const sp = toStorePurchase(first);
              if (sp) done({ kind: 'purchased', purchase: sp });
            }
          })
          .catch((e: unknown) => {
            const code = String(rec(e)['code'] ?? 'unknown');
            done(code === 'user-cancelled' ? { kind: 'cancelled' } : { kind: 'failed', code });
          });
      });
    },
    async finish(purchase) {
      await finishTransaction({ purchase: purchase.handle as Purchase, isConsumable: false });
    },
    async restore() {
      const all = await getAvailablePurchases();
      return all.map(toStorePurchase).filter((x): x is StorePurchase => x !== null);
    },
    async manageSubscriptions(productId) {
      await deepLinkToSubscriptions(
        platform === 'android' ? { packageNameAndroid: PACKAGE, skuAndroid: productId ?? null } : undefined,
      );
    },
  };
}
