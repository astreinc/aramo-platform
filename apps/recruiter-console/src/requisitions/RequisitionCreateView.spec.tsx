import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { RequisitionCreateView } from './RequisitionCreateView';

function makeSession(scopes: string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes,
    iat: 0,
    exp: 0,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RequisitionCreateView', () => {
  it('renders the page header + the form note about D5-hidden compensation', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(
      <MemoryRouter initialEntries={['/requisitions/new']}>
        <Routes>
          <Route
            path="/requisitions/new"
            element={
              <RequisitionCreateView
                sessionOverride={makeSession(['requisition:create'])}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('New requisition')).toBeInTheDocument();
    });
    expect(
      screen.getByText(/compensation fields appear only where you have permission/i),
    ).toBeInTheDocument();
  });

  it('navigates to the new requisition detail on successful create', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes('/v1/companies') && method === 'GET') {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'co-1',
                tenant_id: 't',
                site_id: null,
                name: 'Acme Corp',
                address: null,
                address2: null,
                city: null,
                state: null,
                zip: null,
                phone1: null,
                phone2: null,
                fax_number: null,
                url: null,
                key_technologies: null,
                notes: null,
                is_hot: false,
                billing_contact_id: null,
                owner_id: null,
                entered_by_id: null,
                created_at: '2026-06-01T00:00:00Z',
                updated_at: '2026-06-01T00:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/contacts')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/v1/requisitions' && method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'new-req', title: 'New Role' }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    });
    render(
      <MemoryRouter initialEntries={['/requisitions/new']}>
        <Routes>
          <Route
            path="/requisitions/new"
            element={
              <RequisitionCreateView
                sessionOverride={makeSession(['requisition:create'])}
              />
            }
          />
          <Route
            path="/requisitions/:reqId"
            element={<p data-testid="detail">DETAIL of {window.location.pathname}</p>}
          />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'New Role' },
    });
    fireEvent.click(screen.getByRole('combobox', { name: 'Company' }));
    fireEvent.click(await screen.findByRole('option', { name: /Acme Corp/i }));
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => {
      expect(screen.getByTestId('detail')).toBeInTheDocument();
    });
  });
});
