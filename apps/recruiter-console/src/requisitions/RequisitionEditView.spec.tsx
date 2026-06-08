import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { RequisitionEditView } from './RequisitionEditView';

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

describe('RequisitionEditView', () => {
  it('pre-fetches the requisition and renders the form with title pre-filled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/v1/requisitions/req-42')) {
        return new Response(
          JSON.stringify({
            id: 'req-42',
            tenant_id: 't',
            site_id: null,
            title: 'Senior Engineer',
            company_id: 'co-1',
            contact_id: null,
            company_department_id: null,
            status: 'active',
            type: null,
            duration: null,
            description: null,
            notes: null,
            is_hot: false,
            openings: 2,
            openings_available: 2,
            start_date: null,
            city: null,
            state: null,
            recruiter_id: null,
            owner_id: null,
            entered_by_id: null,
            created_at: '2026-06-01T00:00:00Z',
            updated_at: '2026-06-01T00:00:00Z',
            compensation_model: null,
            pay_rate_amount: null,
            pay_rate_currency: null,
            pay_rate_period: null,
            bill_rate_amount: null,
            bill_rate_currency: null,
            bill_rate_period: null,
            placement_fee_percent: null,
            placement_fee_amount: null,
            salary_amount: null,
            salary_currency: null,
            margin_amount: null,
            markup_percent: null,
            margin_percent: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/v1/companies')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/v1/contacts')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    render(
      <MemoryRouter initialEntries={['/requisitions/req-42/edit']}>
        <Routes>
          <Route
            path="/requisitions/:reqId/edit"
            element={
              <RequisitionEditView
                sessionOverride={makeSession(['requisition:edit'])}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('Edit: Senior Engineer')).toBeInTheDocument();
    });
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(title.value).toBe('Senior Engineer');
  });

  it('surfaces a friendly error when the pre-fetch returns 404', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    render(
      <MemoryRouter initialEntries={['/requisitions/req-gone/edit']}>
        <Routes>
          <Route
            path="/requisitions/:reqId/edit"
            element={
              <RequisitionEditView
                sessionOverride={makeSession(['requisition:edit'])}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/this requisition is not available/i),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole('link', { name: /back to requisitions/i }),
    ).toBeInTheDocument();
  });
});
