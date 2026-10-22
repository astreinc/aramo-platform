import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TenantProfileForm } from './TenantProfileForm';
import type { ProfilePatch, TenantProfileView } from './profile-api';

// ORG-UX-1 (§8.2; handoff §6.2) — the organization profile form.

function view(over: Partial<TenantProfileView> = {}): TenantProfileView {
  return {
    id: 't1',
    name: 'astre',
    legal_name: null,
    display_name: null,
    address_line1: null,
    address_line2: null,
    city: null,
    state_province: null,
    postal_code: null,
    country_code: null,
    tax_id: null,
    registration_number: null,
    primary_contact_name: null,
    primary_contact_email: null,
    primary_contact_phone: null,
    logo_url: null,
    updated_at: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

function renderForm(opts: { fetchFn?: () => Promise<TenantProfileView>; saveFn?: (p: ProfilePatch) => Promise<TenantProfileView> }) {
  return render(
    <ToastProvider>
      <TenantProfileForm fetchFn={opts.fetchFn ?? (() => Promise.resolve(view()))} saveFn={opts.saveFn} host="astre.aramo.ai" />
    </ToastProvider>,
  );
}

describe('TenantProfileForm', () => {
  it('populates the fields, the read-only workspace name with its host, and the relabelled identifiers', async () => {
    renderForm({ fetchFn: () => Promise.resolve(view({ legal_name: 'Astre Inc', city: 'Vienna', tax_id: '12-3', registration_number: '999' })) });
    await waitFor(() => expect(screen.getByTestId('profile-field-legal_name')).toHaveValue('Astre Inc'));
    expect(screen.getByTestId('profile-field-city')).toHaveValue('Vienna');
    const ws = screen.getByTestId('profile-workspace-name');
    expect(ws).toHaveValue('astre');
    expect(ws).toHaveAttribute('readonly');
    expect(screen.getByText('Set when your organization was created · astre.aramo.ai')).toBeInTheDocument();
    expect(screen.getByLabelText('EIN / Tax ID')).toHaveValue('12-3');
    expect(screen.getByLabelText('DUNS / registration number')).toHaveValue('999');
    expect(screen.getByText('Shown in app headers and emails')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Suite, floor (optional)')).toBeInTheDocument();
  });

  it('keeps the logo URL field and has no Upload logo button (G1)', async () => {
    renderForm({});
    await waitFor(() => expect(screen.getByLabelText('Logo URL')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /upload logo/i })).toBeNull();
  });

  it('warns when Country is empty', async () => {
    renderForm({});
    await waitFor(() => expect(screen.getByTestId('profile-field-country_code')).toBeInTheDocument());
    expect(screen.getByTestId('profile-field-country_code')).toHaveClass('ox-input--warn');
    expect(screen.getByText('Needed for invoices and documents')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('profile-field-country_code'), { target: { value: 'US' } });
    expect(screen.queryByText('Needed for invoices and documents')).toBeNull();
  });

  it('shows the unsaved bar only after a change; Discard restores the saved values', async () => {
    renderForm({ fetchFn: () => Promise.resolve(view({ city: 'Vienna' })) });
    await waitFor(() => expect(screen.getByTestId('profile-field-city')).toHaveValue('Vienna'));
    expect(screen.queryByTestId('profile-unsaved-bar')).toBeNull();
    fireEvent.change(screen.getByTestId('profile-field-city'), { target: { value: 'Reston' } });
    const bar = screen.getByTestId('profile-unsaved-bar');
    expect(bar).toHaveTextContent('Unsaved changes to the organization profile');
    fireEvent.click(screen.getByTestId('profile-discard'));
    expect(screen.getByTestId('profile-field-city')).toHaveValue('Vienna');
    expect(screen.queryByTestId('profile-unsaved-bar')).toBeNull();
  });

  it('Save PATCHes only the changed fields, then the bar goes away', async () => {
    const saveFn = vi.fn(async (p: ProfilePatch) => view({ city: 'Vienna', legal_name: p.legal_name ?? null }));
    renderForm({ fetchFn: () => Promise.resolve(view({ city: 'Vienna' })), saveFn });
    await waitFor(() => expect(screen.getByTestId('profile-field-legal_name')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('profile-field-legal_name'), { target: { value: 'Astre Consulting' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(saveFn).toHaveBeenCalledWith({ legal_name: 'Astre Consulting' }));
    await waitFor(() => expect(screen.queryByTestId('profile-unsaved-bar')).toBeNull());
  });

  it('maps organization_country_not_supported to the Country field message', async () => {
    const saveFn = vi.fn(async () => {
      throw new ApiError(400, 'server text', 'VALIDATION_ERROR', { reason: 'organization_country_not_supported' });
    });
    renderForm({ saveFn });
    await waitFor(() => expect(screen.getByTestId('profile-field-country_code')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('profile-field-country_code'), { target: { value: 'IN' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Aramo currently supports organizations in the United States.');
    expect(screen.getByTestId('profile-field-country_code')).toHaveAttribute('aria-invalid', 'true');
  });

  it('maps organization_profile_incomplete to the address message', async () => {
    const saveFn = vi.fn(async () => {
      throw new ApiError(400, 'server text', 'VALIDATION_ERROR', { reason: 'organization_profile_incomplete' });
    });
    renderForm({ saveFn });
    await waitFor(() => expect(screen.getByTestId('profile-field-city')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('profile-field-city'), { target: { value: 'Reston' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Complete the required address fields.');
    expect(screen.getByTestId('profile-address-error')).toBe(alert);
  });
});
