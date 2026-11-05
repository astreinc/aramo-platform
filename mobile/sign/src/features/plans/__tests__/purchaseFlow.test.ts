// M-A12 W1-G.3 — in-app purchase through the StorePort (mocked): success, cancel,
// pending, a verify refusal, an intent refusal, and restore. A transaction is finished
// only after the server accepted it.
import { ApiError } from '../../../api/errors';
import type { StorePlatform } from '../../../api/m-a12-contract-types';
import { PLANS_COPY, type Account } from '../plansModel';
import { buy, restore, type StoreBillingApi } from '../purchaseFlow';
import type { StorePort, StoreProductInfo, StorePurchase, StorePurchaseResult } from '../storePort';

const PRODUCT: StoreProductInfo = { productId: 'ai.aramo.sign.standard.month', displayPrice: '₹799.00', currency: 'INR', offerToken: 'offer-1' };
const ACCOUNT = { tenant_kind: 'PERSONAL', managed_by: 'APP_STORE' } as unknown as Account;
const PURCHASE: StorePurchase = { productId: PRODUCT.productId, token: 'proof-token', handle: { id: 't1' } };

function fakeStore(platform: StorePlatform, result: StorePurchaseResult, restored: StorePurchase[] = []): jest.Mocked<StorePort> {
  return {
    platform,
    connect: jest.fn(async () => true),
    disconnect: jest.fn(async () => undefined),
    products: jest.fn(async (_ids: readonly string[]) => [PRODUCT]),
    purchase: jest.fn(async (_p: StoreProductInfo, _token: string) => result),
    finish: jest.fn(async (_p: StorePurchase) => undefined),
    restore: jest.fn(async () => restored),
    manageSubscriptions: jest.fn(async (_id?: string) => undefined),
  };
}

function fakeApi(over: Partial<StoreBillingApi> = {}): jest.Mocked<StoreBillingApi> {
  return {
    plans: jest.fn(async () => []),
    intent: jest.fn(async () => ({ intent_id: 'intent-1', app_account_token: 'acct-uuid' })),
    verify: jest.fn(async () => ACCOUNT),
    restore: jest.fn(async () => ACCOUNT),
    ...over,
  } as jest.Mocked<StoreBillingApi>;
}

describe('buy', () => {
  it('success (iOS): intent → purchase with appAccountToken → verify with the JWS → finish', async () => {
    const store = fakeStore('ios', { kind: 'purchased', purchase: PURCHASE });
    const api = fakeApi();
    const r = await buy({ store, api }, PRODUCT);
    expect(r).toEqual({ kind: 'purchased', account: ACCOUNT });
    expect(api.intent).toHaveBeenCalledWith({ platform: 'ios', product_id: PRODUCT.productId });
    expect(store.purchase).toHaveBeenCalledWith(PRODUCT, 'acct-uuid');
    expect(api.verify).toHaveBeenCalledWith({
      platform: 'ios',
      product_id: PRODUCT.productId,
      intent_id: 'intent-1',
      signed_transaction: 'proof-token',
    });
    expect(store.finish).toHaveBeenCalledWith(PURCHASE);
    expect(api.verify.mock.invocationCallOrder[0]!).toBeLessThan(store.finish.mock.invocationCallOrder[0]!);
  });

  it('success (Android): the purchase token goes to verify', async () => {
    const store = fakeStore('android', { kind: 'purchased', purchase: PURCHASE });
    const api = fakeApi();
    await buy({ store, api }, PRODUCT);
    expect(api.verify).toHaveBeenCalledWith(expect.objectContaining({ platform: 'android', purchase_token: 'proof-token' }));
    expect(api.verify.mock.calls[0]?.[0]).not.toHaveProperty('signed_transaction');
  });

  it('cancel: no verify, no finish, nothing to show', async () => {
    const store = fakeStore('ios', { kind: 'cancelled' });
    const api = fakeApi();
    expect(await buy({ store, api }, PRODUCT)).toEqual({ kind: 'cancelled' });
    expect(api.verify).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('pending: no verify, no finish, the pending copy', async () => {
    const store = fakeStore('android', { kind: 'pending' });
    const api = fakeApi();
    expect(await buy({ store, api }, PRODUCT)).toEqual({ kind: 'pending', message: PLANS_COPY.pending });
    expect(api.verify).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('verify refusal: the transaction is NOT finished and the reason is shown', async () => {
    const store = fakeStore('ios', { kind: 'purchased', purchase: PURCHASE });
    const api = fakeApi({
      verify: jest.fn(async () => {
        throw new ApiError({ status: 409, code: 'store_purchase_bound_elsewhere', reason: 'store_purchase_bound_elsewhere', details: {} });
      }),
    });
    expect(await buy({ store, api }, PRODUCT)).toEqual({ kind: 'refused', message: PLANS_COPY.boundElsewhere });
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('a network failure at verify keeps the transaction for Restore', async () => {
    const store = fakeStore('ios', { kind: 'purchased', purchase: PURCHASE });
    const api = fakeApi({
      verify: jest.fn(async () => {
        throw new ApiError({ status: 0, code: 'network_unavailable', reason: 'network_unavailable' });
      }),
    });
    expect(await buy({ store, api }, PRODUCT)).toEqual({ kind: 'failed', message: PLANS_COPY.verifyFailed });
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('intent refusal: the store sheet never opens', async () => {
    const store = fakeStore('ios', { kind: 'purchased', purchase: PURCHASE });
    const api = fakeApi({
      intent: jest.fn(async () => {
        throw new ApiError({ status: 409, code: 'store_purchase_seats_unsupported', reason: 'store_purchase_seats_unsupported', details: {} });
      }),
    });
    expect(await buy({ store, api }, PRODUCT)).toEqual({ kind: 'refused', message: PLANS_COPY.teamOnWeb });
    expect(store.purchase).not.toHaveBeenCalled();
  });
});

describe('restore', () => {
  it('sends the store subscriptions, then finishes them', async () => {
    const store = fakeStore('ios', { kind: 'cancelled' }, [PURCHASE]);
    const api = fakeApi();
    expect(await restore({ store, api })).toEqual({ kind: 'restored', account: ACCOUNT });
    expect(api.restore).toHaveBeenCalledWith({ platform: 'ios', signed_transactions: ['proof-token'] });
    expect(store.finish).toHaveBeenCalledWith(PURCHASE);
  });

  it('Android sends purchase tokens', async () => {
    const store = fakeStore('android', { kind: 'cancelled' }, [PURCHASE]);
    const api = fakeApi();
    await restore({ store, api });
    expect(api.restore).toHaveBeenCalledWith({ platform: 'android', purchase_tokens: ['proof-token'] });
  });

  it('nothing to restore: no server call', async () => {
    const store = fakeStore('ios', { kind: 'cancelled' }, []);
    const api = fakeApi();
    expect(await restore({ store, api })).toEqual({ kind: 'none' });
    expect(api.restore).not.toHaveBeenCalled();
  });

  it('a refused restore finishes nothing', async () => {
    const store = fakeStore('ios', { kind: 'cancelled' }, [PURCHASE]);
    const api = fakeApi({
      restore: jest.fn(async () => {
        throw new ApiError({ status: 409, code: 'store_purchase_bound_elsewhere', reason: 'store_purchase_bound_elsewhere', details: {} });
      }),
    });
    expect(await restore({ store, api })).toEqual({ kind: 'refused', message: PLANS_COPY.boundElsewhere });
    expect(store.finish).not.toHaveBeenCalled();
  });
});
