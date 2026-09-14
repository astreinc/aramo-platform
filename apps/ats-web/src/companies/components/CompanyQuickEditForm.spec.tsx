import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CompanyView } from '../types';

import { CompanyQuickEditForm } from './CompanyQuickEditForm';

// Company Party/Role (ADR-0032, R6) — the focused quick-edit form. Covers the
// relationship body-building it owns (per-role status on create; edit diff;
// Amendment-3 de-select → INACTIVE).

function rel(type: string, status: string) {
  return {
    id: `rel-${type}`, type, status,
    effective_from: null, effective_to: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}
function makeCompany(over: Partial<CompanyView> = {}): CompanyView {
  return {
    id: 'co-1', tenant_id: 't', site_id: null, name: 'Acme Corp',
    address: null, address2: null, city: null, state: null, zip: null,
    phone1: null, phone2: null, fax_number: null, url: null,
    key_technologies: null, notes: null, is_hot: false,
    billing_contact_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    status: 'active', relationships: [rel('CLIENT', 'ACTIVE')],
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

describe('CompanyQuickEditForm', () => {
  it('renders relationship rows at the top with per-role status', () => {
    render(
      <CompanyQuickEditForm mode="create" canSeeCommercial={false} submitting={false} onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.getByText('Client')).toBeInTheDocument();
    expect(screen.getByText('Vendor')).toBeInTheDocument();
    expect(screen.getByText('Partner')).toBeInTheDocument();
    expect(screen.getByLabelText('Client status')).toBeInTheDocument();
  });

  it('create: sends name + the selected roles with their own status (VR8)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanyQuickEditForm mode="create" canSeeCommercial={false} submitting={false} onCancel={vi.fn()} onSubmit={onSubmit} />,
    );
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'NewCo' } });
    // add a VENDOR role with ON_HOLD
    fireEvent.click(screen.getByRole('checkbox', { name: /Vendor/i }));
    fireEvent.change(screen.getByLabelText('Vendor status'), { target: { value: 'ON_HOLD' } });
    fireEvent.click(screen.getByRole('button', { name: /save company/i }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0][0];
    expect(body.name).toBe('NewCo');
    expect(body.relationships).toEqual([
      { type: 'CLIENT', status: 'PROSPECT' },
      { type: 'VENDOR', status: 'ON_HOLD' },
    ]);
  });

  it('create is blocked with no role selected (≥1 required, VR8)', () => {
    render(
      <CompanyQuickEditForm mode="create" canSeeCommercial={false} submitting={false} onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Company name'), { target: { value: 'NewCo' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Client/i })); // uncheck the default
    expect(screen.getByRole('button', { name: /save company/i })).toBeDisabled();
  });

  it('edit: unchecking a present role transitions it to INACTIVE (Amendment 3)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const company = makeCompany({
      relationships: [rel('CLIENT', 'ACTIVE'), rel('VENDOR', 'ACTIVE')],
    });
    render(
      <CompanyQuickEditForm mode="edit" initial={company} canSeeCommercial={false} submitting={false} onCancel={vi.fn()} onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Vendor/i })); // de-select VENDOR
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0][0];
    expect(body.relationships).toEqual([
      { type: 'CLIENT', status: 'ACTIVE' },
      { type: 'VENDOR', status: 'INACTIVE' },
    ]);
  });

  it('edit: a no-op change sends an empty patch (no relationships key)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanyQuickEditForm mode="edit" initial={makeCompany()} canSeeCommercial={false} submitting={false} onCancel={vi.fn()} onSubmit={onSubmit} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('relationships');
  });
});
