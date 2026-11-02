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
    deleted_at: null, deleted_by_id: null, contact_kind: null,
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

  // CONTACTS-1 FE-SD-1 — the drawer delete icon (contact:delete holders only).
  it('edit mode without canDelete shows no delete icon', () => {
    installFetch();
    renderDrawer(
      <ContactEditDrawer mode="edit" contact={makeContact()} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.queryByTestId('contact-drawer-delete')).toBeNull();
  });

  it('create mode never shows the delete icon', () => {
    installFetch();
    renderDrawer(
      <ContactEditDrawer mode="create" contact={null} canDelete onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(screen.queryByTestId('contact-drawer-delete')).toBeNull();
  });

  it('the delete icon asks for confirmation, then DELETEs and reports onDeleted', async () => {
    installFetch();
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    renderDrawer(
      <ContactEditDrawer
        mode="edit"
        contact={makeContact()}
        canDelete
        onDeleted={onDeleted}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );
    const icon = screen.getByRole('button', { name: 'Delete Dana Okafor' });
    fireEvent.click(icon);
    expect(await screen.findByText('Delete Dana Okafor?')).toBeInTheDocument();
    // nothing is deleted before the confirmation
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    // Esc belongs to the confirmation while it is open — the drawer stays.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('contact-delete-confirm'));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    const del = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(del?.[0])).toContain('/v1/contacts/ct-1');
  });
});
