// M-A12 W1-G — the Plans screen: server plans as tabs, the STORE's localized price, the
// interval toggle only with both intervals, the platform renewal note, Restore, and the
// fallback (no price, no link) while store billing is off.
import { fireEvent, render, screen } from '@testing-library/react-native';

import { BUSINESS_MEMBERS_URL, BUSINESS_PLAN_URL, BUSINESS_WEB_COPY, MANAGE_ON_WEB, ORG_PLAN_COPY, PLANS_COPY, STORE_NOTE } from '../../../features/plans/plansModel';
import { account, plan } from '../../../features/plans/__tests__/plansFixtures';
import type { StoreProductInfo } from '../../../features/plans/storePort';
import { PlansView } from '../PlansScreen';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(() => Promise.resolve()) }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const webBrowser = require('expo-web-browser') as { openBrowserAsync: jest.Mock };

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

  // PO 2026-11-13 — Business plans are per user: the admin finishes users, roles and access and
  // chooses the plan on the web; the app shows no price, no buy and no store note for Business.
  const businessPlans = [
    plan('business', { name: 'Business', tenant_kind: 'BUSINESS', store_products: [] }),
    plan('professional', { name: 'Professional', tenant_kind: 'BUSINESS', store_products: [] }),
  ];

  it('a Business admin sees the per-user note and links to the web plan and users pages', () => {
    webBrowser.openBrowserAsync.mockClear();
    render(<PlansView {...props({ plans: businessPlans, account: account({ tenant_kind: 'BUSINESS', can_manage_billing: true }) })} />);
    expect(screen.getByTestId('plans-business-message').props.children).toBe(BUSINESS_WEB_COPY);
    expect(screen.queryByTestId('plan-continue')).toBeNull();
    expect(screen.queryByTestId('plan-price')).toBeNull();
    expect(screen.queryByTestId('plan-blocked')).toBeNull();
    expect(screen.queryByText(PLANS_COPY.priceUnavailable)).toBeNull();
    expect(screen.queryByTestId('store-note')).toBeNull();
    expect(screen.queryByTestId('plans-restore')).toBeNull();
    fireEvent.press(screen.getByTestId('plans-business-plan'));
    expect(webBrowser.openBrowserAsync).toHaveBeenCalledWith(BUSINESS_PLAN_URL);
    fireEvent.press(screen.getByTestId('plans-business-members'));
    expect(webBrowser.openBrowserAsync).toHaveBeenCalledWith(BUSINESS_MEMBERS_URL);
  });

  it('a Business member who is not an admin is told the admin manages it, with no link', () => {
    render(<PlansView {...props({ plans: businessPlans, account: account({ tenant_kind: 'BUSINESS', can_manage_billing: false }) })} />);
    expect(screen.getByTestId('plan-blocked').props.children).toBe(ORG_PLAN_COPY);
    expect(screen.queryByTestId('plans-business-web')).toBeNull();
    expect(screen.queryByTestId('plans-restore')).toBeNull();
  });
});
