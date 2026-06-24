import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TenantProfileForm } from './TenantProfileForm';
import type { ProfilePatch, TenantProfileView } from './profile-api';

// Settings Rebuild Directive 3 — tenant-profile form (live GET/PATCH).

function view(over: Partial<TenantProfileView> = {}): TenantProfileView {
  return {
    id: 't1',
    name: 'Astre',
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

function renderForm(opts: {
  fetchFn?: () => Promise<TenantProfileView>;
  saveFn?: (p: ProfilePatch) => Promise<TenantProfileView>;
}) {
  return render(
    <ToastProvider>
      <TenantProfileForm fetchFn={opts.fetchFn} saveFn={opts.saveFn} />
    </ToastProvider>,
  );
}

describe('TenantProfileForm', () => {
  it('GET-populates the fields and shows the read-only workspace name', async () => {
    renderForm({ fetchFn: () => Promise.resolve(view({ legal_name: 'Astre Inc', city: 'Vienna' })) });
    await waitFor(() =>
      expect(screen.getByTestId('profile-field-legal_name')).toHaveValue('Astre Inc'),
    );
    expect(screen.getByTestId('profile-field-city')).toHaveValue('Vienna');
    expect(screen.getByText(/Astre/)).toBeInTheDocument();
  });

  it('Save is disabled until a field changes, then PATCHes only the changed fields', async () => {
    const saveFn = vi.fn(async (p: ProfilePatch) => view({ ...p, legal_name: p.legal_name ?? null }));
    renderForm({ fetchFn: () => Promise.resolve(view({ city: 'Vienna' })), saveFn });
    await waitFor(() => expect(screen.getByTestId('profile-save')).toBeDisabled());

    fireEvent.change(screen.getByTestId('profile-field-legal_name'), {
      target: { value: 'Astre Consulting' },
    });
    expect(screen.getByTestId('profile-save')).toBeEnabled();
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(saveFn).toHaveBeenCalledWith({ legal_name: 'Astre Consulting' }));
  });

  it('surfaces a backend validation error (operator-legible)', async () => {
    const saveFn = vi.fn(async () => {
      throw new ApiError(400, 'bad', 'VALIDATION_ERROR', { reason: 'invalid_email', field: 'primary_contact_email' });
    });
    renderForm({ fetchFn: () => Promise.resolve(view()), saveFn });
    await waitFor(() => screen.getByTestId('profile-field-primary_contact_email'));
    fireEvent.change(screen.getByTestId('profile-field-primary_contact_email'), {
      target: { value: 'nope' },
    });
    fireEvent.click(screen.getByTestId('profile-save'));
    expect(await screen.findByText(/not a valid email/i)).toBeInTheDocument();
  });

  it('shows an error state when the profile cannot load', async () => {
    renderForm({ fetchFn: () => Promise.reject(new Error('boom')) });
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('renders country as a Combobox; an already-set code initializes to the country name', async () => {
    renderForm({ fetchFn: () => Promise.resolve(view({ country_code: 'US' })) });
    const trigger = await screen.findByRole('combobox', { name: 'Country' });
    expect(trigger).toHaveTextContent('United States of America');
  });

  it('an unset country shows the placeholder, not a pre-filled value', async () => {
    renderForm({ fetchFn: () => Promise.resolve(view({ country_code: null })) });
    const trigger = await screen.findByRole('combobox', { name: 'Country' });
    expect(trigger).toHaveTextContent('Select country…');
  });

  it('selecting a country PATCHes the 2-letter ISO code', async () => {
    const saveFn = vi.fn(async (p: ProfilePatch) => view({ ...p }));
    renderForm({ fetchFn: () => Promise.resolve(view()), saveFn });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Country' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Canada' }));
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(saveFn).toHaveBeenCalledWith({ country_code: 'CA' }));
  });
});
