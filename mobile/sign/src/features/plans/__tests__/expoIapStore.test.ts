// Android Play Release Build (vc7) directive §2 item 3 — the StorePort adapter over expo-iap on
// Android: the offer token, the account link the server matches (obfuscatedAccountId = the
// intent's app_account_token), acknowledgement through finishTransaction, the manage deep link,
// and a user cancel.
import type { StoreProductInfo } from '../storePort';

type Listener = (v: unknown) => void;
const mockListeners: { updated: Listener[]; failed: Listener[] } = { updated: [], failed: [] };

const mockIap = {
  initConnection: jest.fn(async () => true),
  endConnection: jest.fn(async () => undefined),
  fetchProducts: jest.fn(async (_: unknown): Promise<unknown[]> => []),
  requestPurchase: jest.fn(async (_: unknown): Promise<unknown> => null),
  finishTransaction: jest.fn(async (_: unknown) => undefined),
  getAvailablePurchases: jest.fn(async (): Promise<unknown[]> => []),
  deepLinkToSubscriptions: jest.fn(async (_: unknown) => undefined),
  purchaseUpdatedListener: jest.fn((fn: Listener) => {
    mockListeners.updated.push(fn);
    return { remove: jest.fn() };
  }),
  purchaseErrorListener: jest.fn((fn: Listener) => {
    mockListeners.failed.push(fn);
    return { remove: jest.fn() };
  }),
};

jest.mock('expo-iap', () => mockIap);
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createExpoIapStore } = require('../expoIapStore') as typeof import('../expoIapStore');

const SKU = 'ai.aramo.sign.personal_standard.monthly';
const PRODUCT: StoreProductInfo = { productId: SKU, displayPrice: '$10.00', currency: 'USD', offerToken: 'offer-tok' };
const ACCOUNT_TOKEN = '0b9c6f0e-1d2a-4c3b-9e8f-7a6b5c4d3e2f';

beforeEach(() => {
  mockListeners.updated = [];
  mockListeners.failed = [];
});

describe('expoIapStore (Android)', () => {
  it('reports the android platform', () => {
    expect(createExpoIapStore().platform).toBe('android');
  });

  it('products: the Android offer token travels with the product', async () => {
    mockIap.fetchProducts.mockResolvedValueOnce([
      { id: SKU, displayPrice: '$10.00', currency: 'USD', subscriptionOffers: [{ offerTokenAndroid: 'offer-tok' }] },
      { id: 'no-price' },
    ]);
    const out = await createExpoIapStore().products([SKU]);
    expect(mockIap.fetchProducts).toHaveBeenCalledWith({ skus: [SKU], type: 'subs' });
    expect(out).toEqual([PRODUCT]);
  });

  it('purchase: obfuscatedAccountId is the account token and the offer token is sent', async () => {
    mockIap.requestPurchase.mockResolvedValueOnce([{ productId: SKU, purchaseState: 'purchased', purchaseToken: 'play-token' }]);
    const r = await createExpoIapStore().purchase(PRODUCT, ACCOUNT_TOKEN);
    const req = mockIap.requestPurchase.mock.calls[0]![0] as { type: string; request: { google: Record<string, unknown> } };
    expect(req.type).toBe('subs');
    expect(req.request.google).toEqual({
      skus: [SKU],
      obfuscatedAccountId: ACCOUNT_TOKEN,
      subscriptionOffers: [{ sku: SKU, offerToken: 'offer-tok' }],
    });
    expect(r).toMatchObject({ kind: 'purchased', purchase: { productId: SKU, token: 'play-token' } });
  });

  it('purchase: a user cancel is "cancelled", never a failure', async () => {
    mockIap.requestPurchase.mockImplementationOnce(async () => {
      mockListeners.failed.forEach((fn) => fn({ code: 'user-cancelled' }));
      return null;
    });
    expect(await createExpoIapStore().purchase(PRODUCT, ACCOUNT_TOKEN)).toEqual({ kind: 'cancelled' });
  });

  it('finish acknowledges as a non-consumable (Play refunds an unacknowledged purchase)', async () => {
    const handle = { productId: SKU, purchaseToken: 'play-token' };
    await createExpoIapStore().finish({ productId: SKU, token: 'play-token', handle });
    expect(mockIap.finishTransaction).toHaveBeenCalledWith({ purchase: handle, isConsumable: false });
  });

  it('manage subscriptions deep-links to the package and SKU', async () => {
    await createExpoIapStore().manageSubscriptions(SKU);
    expect(mockIap.deepLinkToSubscriptions).toHaveBeenCalledWith({ packageNameAndroid: 'ai.aramo.sign', skuAndroid: SKU });
  });
});
