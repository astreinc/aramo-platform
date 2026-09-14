import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContactView } from '../../companies/types';

import { ContactEditDrawer } from './ContactEditDrawer';

// Contacts prototype parity — the shared create/edit slide-over. This spec
// covers the drawer SHELL (modes, EDITING badge, Open-full-record, close, Esc);
// the form body + body-builders are covered by ContactQuickEditForm.spec.

function makeContact(over: Partial<ContactView> = {}): ContactView {
  return {
    id: 'ct-1', tenant_id: 't', site_id: null,
    first_name: 'Dana', last_name: 'Okafor', title: 'VP Engineering',
    email1: null, email2: null,
    phone_work: null, phone_cell: null, phone_other: null,
    address: null, company_id: 'co-1', company_department_id: null,
    is_hot: false, notes: null, left_company: false,
    is_primary: false, reports_to_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    relationship_role: null, preference: null, last_activity_at: null,
    company_name: 'Northwind Systems', relationship_types: ['CLIENT'],
    ...over,
  };
}

function installFetch() {
  // The form loads companies (create) + assignable-users (both) — empty is fine.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function renderDrawer(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('ContactEditDrawer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('edit mode: shows the contact name + EDITING badge (no full-record link)', async () => {
    installFetch();
    renderDrawer(
      <ContactEditDrawer
        mode="edit"
        contact={makeContact()}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId('contact-edit-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('contact-edit-badge')).toHaveTextContent(/editing/i);
    // the drawer is the only surface — there is no "open full record" link
    expect(screen.queryByTestId('contact-open-full-record')).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument(),
    );
  });

  it('create mode: "New contact" title, no EDITING badge, no full-record link', () => {
    installFetch();
    renderDrawer(
      <ContactEditDrawer
        mode="create"
        contact={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByTestId('contact-edit-drawer')).toBeInTheDocument();
    expect(screen.getByText('New contact')).toBeInTheDocument();
    expect(screen.queryByTestId('contact-edit-badge')).toBeNull();
    expect(screen.queryByTestId('contact-open-full-record')).toBeNull();
  });

  it('the close button fires onClose', () => {
    installFetch();
    const onClose = vi.fn();
    renderDrawer(
      <ContactEditDrawer
        mode="create"
        contact={null}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the drawer (fires onClose)', () => {
    installFetch();
    const onClose = vi.fn();
    renderDrawer(
      <ContactEditDrawer
        mode="edit"
        contact={makeContact()}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
