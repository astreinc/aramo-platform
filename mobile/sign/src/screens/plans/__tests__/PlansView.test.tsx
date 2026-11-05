// M-A12 W1-G — the Plans screen: server plans as tabs, the STORE's localized price, the
// interval toggle only with both intervals, the platform renewal note, Restore, and the
// fallback (no price, no link) while store billing is off.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { MANAGE_ON_WEB, PLANS_COPY, STORE_NOTE } from '../../../features/plans/plansModel';
import { account, plan } from '../../../features/plans/__tests__/plansFixtures';
import type { StoreProductInfo } from '../../../features/plans/storePort';
import { PlansView } from '../PlansScreen';

const STORE_PRICES: Record<string, StoreProductInfo> = {
  'std.year.ios': { productId: 'std.year.ios', displayPrice: '₹7,999.00', currency: 'INR', offerToken: null },
  'std.month.ios': { productId: 'std.month.ios', displayPrice: '₹799.00', currency: 'INR', offerToken: null },
  'std.month.android': { productId: 'std.month.android', displayPrice: '₹799.00', currency: 'INR', offerToken: 'o1' },
};

function props(over: Partial<Parameters<typeof PlansView>[0]> = {}) {
  return {
    plans: [plan('free'), plan('standard', { price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' } })],
    account: account(),
    platform: 'ios' as const,
    storeOn: true,
    products: STORE_PRICES,
    from: 'home' as const,
    online: true,
    busy: null,
    message: null,
    onBuy: jest.fn(),
    onRestore: jest.fn(),
    onManage: jest.fn(),
    ...over,
  };
}

describe('PlansView', () => {
  it('iOS: store price, yearly/monthly toggle, renewal note, Terms, Privacy and Restore', () => {
    const p = props();
    render(<PlansView {...p} />);
    expect(screen.getByTestId('plan-tab-free')).toBeTruthy();
    expect(screen.getByTestId('plan-tab-standard')).toBeTruthy();
    expect(screen.getByTestId('plan-name').props.children).toBe('Standard');
    expect(screen.getByTestId('plan-price').props.children).toBe('₹7,999.00');
    // The server's USD list price is never shown in the app.
    expect(screen.queryByText(/\$10|10\.00/)).toBeNull();
    fireEvent.press(screen.getByTestId('plan-interval-MONTH'));
    expect(screen.getByTestId('plan-price').props.children).toBe('₹799.00');
    expect(screen.getByTestId('store-note').props.children).toBe(STORE_NOTE.ios);
    expect(screen.getByTestId('plans-terms')).toBeTruthy();
    expect(screen.getByTestId('plans-privacy')).toBeTruthy();
    fireEvent.press(screen.getByTestId('plan-continue'));
    expect(p.onBuy).toHaveBeenCalledWith(STORE_PRICES['std.month.ios']);
    fireEvent.press(screen.getByTestId('plans-restore'));
    expect(p.onRestore).toHaveBeenCalled();
    expect(screen.queryByTestId('plans-manage')).toBeNull();
  });

  it('Android with a monthly product only: no interval toggle; Google Play note', () => {
    render(<PlansView {...props({ platform: 'android' })} />);
    expect(screen.queryByTestId('plan-interval-MONTH')).toBeNull();
    expect(screen.getByTestId('plan-price').props.children).toBe('₹799.00');
    expect(screen.getByTestId('store-note').props.children).toBe(STORE_NOTE.android);
  });

  it('store billing off: plan and features, "Manage your plan at sign.aramo.ai", no price, no links', () => {
    render(<PlansView {...props({ platform: 'android', storeOn: false })} />);
    expect(screen.getByTestId('plan-blocked').props.children).toBe(MANAGE_ON_WEB);
    expect(screen.queryByTestId('plan-price')).toBeNull();
    expect(screen.queryByTestId('plan-continue')).toBeNull();
    expect(screen.queryByTestId('plans-terms')).toBeNull();
    expect(screen.queryByTestId('plans-restore')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a member who can’t manage billing is told to ask their admin', () => {
    render(<PlansView {...props({ account: account({ store_purchase_block_reason: 'not_billing_manager' }) })} />);
    expect(screen.getByTestId('plan-blocked').props.children).toBe(PLANS_COPY.askAdmin);
    expect(screen.queryByTestId('plan-continue')).toBeNull();
  });

  it('a store-billed subscription offers Manage subscription (the store page)', () => {
    const p = props({ account: account({ managed_by: 'APP_STORE' }) });
    render(<PlansView {...p} />);
    fireEvent.press(screen.getByTestId('plans-manage'));
    expect(p.onManage).toHaveBeenCalled();
  });

  it('the current plan is marked', () => {
    render(<PlansView {...props({ account: account({ subscription: { plan_key: 'standard', plan_name: 'Standard', source: 'SELF_SERVICE', ended_at: null } as never }) })} />);
    expect(screen.getByTestId('plan-current')).toBeTruthy();
  });
});
