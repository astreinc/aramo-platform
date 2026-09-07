import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import type { AddressDetails } from '../companies/types';

import { RequisitionCreateView } from './RequisitionCreateView';

// WL-B3 — Requisition Work Location: manual ZIP / Postal code + reuse of the
// existing address-autocomplete component. The shared AddressTypeahead's real
// debounce / session-token / degraded-mode / timeout mechanics are proven in
// companies/AddressTypeahead.spec.tsx; here we prove the REQUISITION-LEVEL
// integration: a selected suggestion fills the structured fields (city / state /
// postal_code), the recruiter can edit them, and the form is NEVER blocked by
// autocomplete — manual entry always works and postal_code round-trips into the
// create body (R3/R5/R12). We mock the shared component to a deterministic
// "pick" button (and a no-op when a degraded provider yields nothing).
const SELECTED: AddressDetails = {
  place_id: 'p1',
  address: '1 A St',
  address2: null,
  city: 'Washington',
  state: 'DC',
  zip: '20005',
  country: 'US',
} as AddressDetails;

vi.mock('../companies/AddressTypeahead', () => ({
  AddressTypeahead: ({
    onSelectAddress,
    testId,
    disabled,
  }: {
    onSelectAddress: (d: AddressDetails) => void;
    testId?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={() => onSelectAddress(SELECTED)}
    >
      pick suggestion
    </button>
  ),
}));

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

const ACME = {
  id: 'co-1', tenant_id: 't', site_id: null, name: 'Acme Corp',
  address: null, address2: null, city: null, state: null, zip: null,
  phone1: null, phone2: null, fax_number: null, url: null, key_technologies: null,
  notes: null, is_hot: false, billing_contact_id: null, owner_id: null,
  entered_by_id: null, created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Mocks fetch; returns the captured POST /v1/requisitions body via the ref.
function mockApi(bodyRef: { current: Record<string, unknown> | null }): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (url === '/v1/requisitions' && method === 'POST') {
      bodyRef.current = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return json({ id: 'new-req', title: 'New Role' }, 201);
    }
    if (url.includes('/v1/companies') && method === 'GET') return json({ items: [ACME] });
    if (url.includes('/v1/contacts')) return json({ items: [] });
    // Degraded/never-block: any address-lookup call returns an empty 200.
    if (url.includes('/v1/address-lookup')) return json({ items: [] });
    return new Response('{}', { status: 404 });
  });
}

async function openManualForm(scopes: string[] = ['requisition:create']): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/requisitions/new']}>
      <Routes>
        <Route
          path="/requisitions/new"
          element={<RequisitionCreateView sessionOverride={makeSession(scopes)} />}
        />
        <Route path="/requisitions/:id" element={<div data-testid="detail" />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /enter the requisition manually/i }));
  fireEvent.change(await screen.findByLabelText('Job title'), { target: { value: 'New Role' } });
  fireEvent.click(screen.getByRole('combobox', { name: 'Company' }));
  fireEvent.click(await screen.findByRole('option', { name: /Acme Corp/i }));
}

afterEach(() => vi.restoreAllMocks());

describe('Requisition Work Location — postal_code + autocomplete (WL-B3)', () => {
  it('1 — manual create WITH postal_code sends it in the body', async () => {
    const body = { current: null as Record<string, unknown> | null };
    mockApi(body);
    await openManualForm();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Washington' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'DC' } });
    fireEvent.change(screen.getByLabelText('ZIP / Postal code'), { target: { value: '20005' } });
    fireEvent.click(screen.getByRole('button', { name: /^create requisition$/i }));
    await screen.findByText(/New Role created/i);
    expect(body.current).toMatchObject({ city: 'Washington', state: 'DC', postal_code: '20005' });
  });

  it('2 — manual create WITHOUT postal_code omits it and still succeeds', async () => {
    const body = { current: null as Record<string, unknown> | null };
    mockApi(body);
    await openManualForm();
    fireEvent.click(screen.getByRole('button', { name: /^create requisition$/i }));
    await screen.findByText(/New Role created/i);
    expect(body.current).not.toBeNull();
    expect(body.current).not.toHaveProperty('postal_code');
  });

  it('3 — selecting an autocomplete suggestion fills city / state / postal_code', async () => {
    const body = { current: null as Record<string, unknown> | null };
    mockApi(body);
    await openManualForm();
    fireEvent.click(screen.getByTestId('req-worklocation-search')); // fires onSelectAddress(SELECTED)
    expect((screen.getByLabelText('City') as HTMLInputElement).value).toBe('Washington');
    expect((screen.getByLabelText('State') as HTMLInputElement).value).toBe('DC');
    expect((screen.getByLabelText('ZIP / Postal code') as HTMLInputElement).value).toBe('20005');
  });

  it('4 — autofilled values remain editable, and the edited value is submitted', async () => {
    const body = { current: null as Record<string, unknown> | null };
    mockApi(body);
    await openManualForm();
    fireEvent.click(screen.getByTestId('req-worklocation-search'));
    // Recruiter corrects the ZIP after autofill.
    fireEvent.change(screen.getByLabelText('ZIP / Postal code'), { target: { value: '20500' } });
    expect((screen.getByLabelText('ZIP / Postal code') as HTMLInputElement).value).toBe('20500');
    fireEvent.click(screen.getByRole('button', { name: /^create requisition$/i }));
    await screen.findByText(/New Role created/i);
    expect(body.current).toMatchObject({ postal_code: '20500' });
  });

  it('5/6/7 — autocomplete unavailable/degraded never blocks: manual create still works', async () => {
    // The address-lookup endpoint returns empty (degraded/off/timeout ≈ no
    // suggestions). Without touching the search, the recruiter fills the
    // structured fields and submits successfully.
    const body = { current: null as Record<string, unknown> | null };
    mockApi(body);
    await openManualForm();
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText('ZIP / Postal code'), { target: { value: '73301' } });
    fireEvent.click(screen.getByRole('button', { name: /^create requisition$/i }));
    await waitFor(() => expect(screen.getByText(/New Role created/i)).toBeInTheDocument());
    expect(body.current).toMatchObject({ city: 'Austin', state: 'TX', postal_code: '73301' });
  });
});
