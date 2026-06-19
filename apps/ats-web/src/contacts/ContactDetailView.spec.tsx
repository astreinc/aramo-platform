import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import type { ContactView } from '../companies/types';

import { ContactDetailView } from './ContactDetailView';

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function makeContact(overrides: Partial<ContactView> = {}): ContactView {
  return {
    id: 'ct-1', tenant_id: 't', site_id: null,
    first_name: 'Dana', last_name: 'Okafor', title: 'VP Engineering',
    email1: 'dana@northwind.test', email2: null,
    phone_work: '+1 555 0142', phone_cell: null, phone_other: null,
    address: 'Austin, TX', company_id: 'co-1', company_department_id: null,
    is_hot: false, notes: null, left_company: false,
    reports_to_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    relationship_role: 'decision_maker', preference: 'contactable',
    last_activity_at: '2026-06-10T00:00:00Z', company_name: 'Northwind Robotics',
    ...overrides,
  };
}

type FetchMap = Record<string, unknown | { status: number; body: unknown }>;

function installFetch(map: FetchMap) {
  const entries = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, value] of entries) {
      if (url.includes(pattern)) {
        const isWrapped =
          typeof value === 'object' && value !== null &&
          'status' in value && 'body' in value;
        const body = isWrapped ? (value as { body: unknown }).body : value;
        const status = isWrapped ? (value as { status: number }).status : 200;
        return new Response(JSON.stringify(body), {
          status, headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderAt(session: Session) {
  return render(
    <MemoryRouter initialEntries={['/contacts/ct-1']}>
      <Routes>
        <Route
          path="/contacts/:contactId"
          element={<ContactDetailView sessionOverride={session} />}
        />
        <Route path="/contacts" element={<p>Contacts list</p>} />
        <Route path="/companies/:companyId" element={<p>Company detail</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ContactDetailView (relationship hub)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the contact header + company link + facts-only briefing', async () => {
    installFetch({
      '/v1/contacts/ct-1': makeContact(),
      '/v1/companies/co-1/team': { owner_id: null, member_user_ids: [] },
      '/v1/tenant/users': { items: [] },
      '/v1/activities': { items: [] },
    });
    renderAt(makeSession(['contact:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Dana Okafor/i })).toBeInTheDocument(),
    );
    // company name links to the company detail (header + Position card both do).
    const coLinks = screen.getAllByRole('link', { name: 'Northwind Robotics' });
    expect(coLinks.length).toBeGreaterThan(0);
    expect(coLinks[0]).toHaveAttribute('href', '/companies/co-1');
    // facts-only briefing: states company + last-contact, NO evaluative verdict.
    expect(screen.getAllByText(/Last contact/i).length).toBeGreaterThan(0);
  });

  it('keeps the R10 disclaimer VERBATIM (no quality rating on people)', async () => {
    installFetch({
      '/v1/contacts/ct-1': makeContact(),
      '/v1/companies/co-1/team': { owner_id: null, member_user_ids: [] },
      '/v1/tenant/users': { items: [] },
      '/v1/activities': { items: [] },
    });
    renderAt(makeSession(['contact:read']));
    await waitFor(() => expect(screen.getByText('Dana Okafor')).toBeInTheDocument());
    expect(
      screen.getByText(/Aramo applies no quality rating to people/i),
    ).toBeInTheDocument();
  });

  it('shows the do-not-contact compliance banner when preference is do_not_contact', async () => {
    installFetch({
      '/v1/contacts/ct-1': makeContact({ preference: 'do_not_contact' }),
      '/v1/companies/co-1/team': { owner_id: null, member_user_ids: [] },
      '/v1/tenant/users': { items: [] },
      '/v1/activities': { items: [] },
    });
    renderAt(makeSession(['contact:read']));
    // the compliance banner (role=note) carries the contact-blocked copy.
    await waitFor(() => expect(screen.getByRole('note')).toBeInTheDocument());
    expect(screen.getByRole('note')).toHaveTextContent(/Do-not-contact\./i);
    expect(screen.getByRole('note')).toHaveTextContent(/asked not to be contacted/i);
  });

  it('surfaces a 404 as an unavailable message with a back link', async () => {
    installFetch({ '/v1/contacts/ct-1': { status: 404, body: { message: 'nope' } } });
    renderAt(makeSession(['contact:read']));
    await waitFor(() =>
      expect(screen.getByText(/this contact is not available/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /back to contacts/i })).toBeInTheDocument();
  });
});
