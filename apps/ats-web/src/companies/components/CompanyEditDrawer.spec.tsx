import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CompanyView } from '../types';

import { CompanyEditDrawer } from './CompanyEditDrawer';

// Company Party/Role (ADR-0032, R6) — the shared create/edit slide-over. This
// spec covers the drawer SHELL (modes, EDITING badge, Open-full-record, close);
// the form body + body-builders are covered by CompanyQuickEditForm.spec.

function makeCompany(over: Partial<CompanyView> = {}): CompanyView {
  return {
    id: 'co-1', tenant_id: 't', site_id: null, name: 'Acme Corp',
    address: null, address2: null, city: null, state: null, zip: null,
    phone1: null, phone2: null, fax_number: null, url: null,
    key_technologies: null, notes: null, is_hot: false,
    billing_contact_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    relationships: [
      {
        id: 'rel-1', type: 'CLIENT', status: 'ACTIVE',
        effective_from: null, effective_to: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    master_status: 'ACTIVE', communication_restricted: false,
    description: null, industry: null, country: null,
    employee_count_band: null, annual_revenue_band: null, founded_year: null,
    ownership_type: null, registration_number: null, source: null,
    client_tier: null, supplier_status: null, exclusivity: false,
    off_limits: false, tags: [], general_email: null,
    last_activity_at: null, next_action_at: null,
    address_provider_place_id: null, address_provider: null,
    ...over,
  };
}

function installFetch() {
  // The edit drawer loads contacts on edit — return empty for all.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function renderDrawer(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('CompanyEditDrawer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('edit mode: shows the company name + EDITING badge + Open full record link', async () => {
    installFetch();
    renderDrawer(
      <CompanyEditDrawer
        mode="edit"
        company={makeCompany()}
        canSeeCommercial={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId('company-edit-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('company-edit-badge')).toHaveTextContent(/editing/i);
    expect(screen.getByTestId('company-open-full-record')).toHaveAttribute(
      'href', '/companies/co-1',
    );
    // the shared form's Save action is present
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument(),
    );
  });

  it('create mode: "New company" title, no EDITING badge, no full-record link', () => {
    installFetch();
    renderDrawer(
      <CompanyEditDrawer
        mode="create"
        company={null}
        canSeeCommercial={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId('company-edit-drawer')).toBeInTheDocument();
    expect(screen.getByText('New company')).toBeInTheDocument();
    expect(screen.queryByTestId('company-edit-badge')).toBeNull();
    expect(screen.queryByTestId('company-open-full-record')).toBeNull();
  });

  it('the close button fires onClose', () => {
    installFetch();
    const onClose = vi.fn();
    renderDrawer(
      <CompanyEditDrawer
        mode="create"
        company={null}
        canSeeCommercial={false}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
