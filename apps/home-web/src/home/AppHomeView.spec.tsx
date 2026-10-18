import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppHomeView } from './AppHomeView';
import type { ProductAvailabilityView } from './products-api';

// D-ORG (§3.D) — the tiles render STRICTLY the backend-authoritative read:
// subscribed / authorized / available are never derived in the FE.
const view: ProductAvailabilityView = {
  tenant_id: 't-1',
  products: [
    { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
    { key: 'esign', subscribed: true, authorized: false, available: false, entry_path: null, reason: 'not_authorized' },
    { key: 'org', subscribed: true, authorized: true, available: true, entry_path: '/org/', reason: null },
  ],
};

function renderHome(v: ProductAvailabilityView = view) {
  return render(
    <MemoryRouter>
      <AppHomeView fetchFn={() => Promise.resolve(v)} />
    </MemoryRouter>,
  );
}

describe('AppHomeView — product tiles', () => {
  it('an available product enters through ITS consumer login with the entry path as return_to', async () => {
    renderHome();
    const ats = await screen.findByTestId('home-tile-ats');
    expect(ats.tagName).toBe('A');
    expect(ats).toHaveAttribute('href', '/auth/recruiter/login?return_to=%2Fats%2F');
  });

  it('the organization tile is an in-app route (/org/)', async () => {
    renderHome();
    const org = await screen.findByTestId('home-tile-org');
    expect(org).toHaveAttribute('href', '/org/');
  });

  it('a subscribed-but-unauthorized product is an honest non-entry (no link) naming the reason', async () => {
    renderHome();
    const esign = await screen.findByTestId('home-tile-esign');
    expect(esign.tagName).toBe('DIV');
    expect(esign).toHaveAttribute('aria-disabled', 'true');
    expect(esign).toHaveTextContent(/ask your organization administrator/i);
  });

  it('an unsubscribed product states it is not in the subscription', async () => {
    renderHome({
      tenant_id: 't-1',
      products: [{ key: 'esign', subscribed: false, authorized: false, available: false, entry_path: null, reason: 'not_subscribed' }],
    });
    expect(await screen.findByTestId('home-tile-esign')).toHaveTextContent(/not included in your organization's subscription/i);
  });

  it('an esign entry opens the Sign product host directly (its own login + access check)', async () => {
    renderHome({
      tenant_id: 't-1',
      products: [{ key: 'esign', subscribed: true, authorized: true, available: true, entry_path: 'https://esign.aramo.ai/', reason: null }],
    });
    expect(await screen.findByTestId('home-tile-esign')).toHaveAttribute('href', 'https://esign.aramo.ai/');
  });
});
