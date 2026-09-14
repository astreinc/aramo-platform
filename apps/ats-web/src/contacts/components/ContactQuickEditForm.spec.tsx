import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContactView } from '../../companies/types';

import { ContactQuickEditForm } from './ContactQuickEditForm';

// Contacts prototype parity — the focused quick-edit form. Covers the body it
// owns: the Company select + Primary checkbox on create; buildCreate sending
// is_primary + owner_id + company_id; the edit buildPatch diff (is_primary).

function makeContact(over: Partial<ContactView> = {}): ContactView {
  return {
    id: 'ct-1', tenant_id: 't', site_id: null,
    first_name: 'Dana', last_name: 'Okafor', title: 'VP Engineering',
    email1: 'dana@nw.test', email2: null,
    phone_work: '(571) 555-0140', phone_cell: null, phone_other: null,
    address: null, company_id: 'co-1', company_department_id: null,
    is_hot: false, notes: null, left_company: false,
    is_primary: false, reports_to_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    relationship_role: null, preference: null, last_activity_at: null,
    company_name: 'Northwind Systems', relationship_types: ['CLIENT'],
    ...over,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(
  companies: readonly { id: string; name: string }[],
  owners: readonly { user_id: string; display_name: string | null }[],
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/v1/tenant/assignable-users')) return json({ items: owners });
    if (url.includes('/v1/companies')) return json({ items: companies });
    return json({ items: [] });
  });
}

describe('ContactQuickEditForm', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the prototype fields incl. Company select + Primary checkbox on create', async () => {
    installFetch([{ id: 'co-1', name: 'Northwind Systems' }], []);
    render(
      <ContactQuickEditForm mode="create" submitting={false} onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(screen.getByLabelText('First name')).toBeInTheDocument();
    expect(screen.getByLabelText('Last name')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    // Company is a <select> on create (populated from searchCompanies)
    const company = screen.getByLabelText('Company');
    expect(company.tagName).toBe('SELECT');
    await screen.findByRole('option', { name: 'Northwind Systems' });
    expect(
      screen.getByLabelText('Primary contact for this company'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone')).toBeInTheDocument();
    expect(screen.getByLabelText('Mobile')).toBeInTheDocument();
    expect(screen.getByLabelText('Account owner')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeInTheDocument();
  });

  it('create is blocked until first + last + company are set', async () => {
    installFetch([{ id: 'co-1', name: 'Northwind Systems' }], []);
    render(
      <ContactQuickEditForm mode="create" submitting={false} onCancel={vi.fn()} onSubmit={vi.fn()} />,
    );
    const save = screen.getByRole('button', { name: /save contact/i });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Doe' } });
    expect(save).toBeDisabled(); // company still unset
    await screen.findByRole('option', { name: 'Northwind Systems' });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-1' } });
    expect(save).not.toBeDisabled();
  });

  it('create: buildCreate sends company_id + is_primary + owner_id', async () => {
    installFetch(
      [{ id: 'co-1', name: 'Northwind Systems' }],
      [{ user_id: 'u-9', display_name: 'Jamie Rivera' }],
    );
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ContactQuickEditForm mode="create" submitting={false} onCancel={vi.fn()} onSubmit={onSubmit} />,
    );
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Doe' } });
    await screen.findByRole('option', { name: 'Northwind Systems' });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'co-1' } });
    fireEvent.click(screen.getByLabelText('Primary contact for this company'));
    await screen.findByRole('option', { name: 'Jamie Rivera' });
    fireEvent.change(screen.getByLabelText('Account owner'), { target: { value: 'u-9' } });
    fireEvent.click(screen.getByRole('button', { name: /save contact/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({
      company_id: 'co-1',
      first_name: 'Jane',
      last_name: 'Doe',
      is_primary: true,
      owner_id: 'u-9',
    });
  });

  it('edit: company is read-only; buildPatch diffs only is_primary', async () => {
    installFetch([], []);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ContactQuickEditForm
        mode="edit"
        initial={makeContact({ is_primary: false })}
        submitting={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    // company fixed → read-only input, not a select
    expect(screen.getByTestId('contact-company-readonly')).toHaveValue('Northwind Systems');
    fireEvent.click(screen.getByLabelText('Primary contact for this company'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({ is_primary: true });
  });

  it('edit: a no-op change sends an empty patch', async () => {
    installFetch([], []);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ContactQuickEditForm
        mode="edit"
        initial={makeContact()}
        submitting={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toEqual({});
  });
});
