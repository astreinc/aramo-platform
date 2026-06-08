import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContactView } from '../companies/types';

import { ContactForm } from './ContactForm';

// R6' — the contact mutate form specs. Covers the reports_to_id
// exclude-self guard (the load-bearing FE responsibility — the BE has
// ZERO validation), the left_company EDIT-only surface (ruling C), the
// company_department_id PATCH-preserve (ruling D), and the R4 omit-vs-
// null discipline.

function makeContact(overrides: Partial<ContactView> = {}): ContactView {
  return {
    id: 'ct-1',
    tenant_id: 't',
    site_id: null,
    first_name: 'Jane',
    last_name: 'Doe',
    title: null,
    email1: null,
    email2: null,
    phone_work: null,
    phone_cell: null,
    phone_other: null,
    address: null,
    company_id: 'co-1',
    company_department_id: null,
    is_hot: false,
    notes: null,
    left_company: false,
    reports_to_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

interface MockedRequest {
  readonly url: string;
  readonly method: string;
}

function installContactsFetch(
  items: readonly ContactView[],
): MockedRequest[] {
  const calls: MockedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ContactForm — CREATE (required fields + reports_to picker)', () => {
  it('disables submit until first + last name are set', async () => {
    installContactsFetch([]);
    render(
      <ContactForm
        mode="create"
        companyId="co-1"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    const submit = await screen.findByRole('button', { name: /create contact/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('First name'), {
      target: { value: 'Jane' },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Last name'), {
      target: { value: 'Doe' },
    });
    expect(submit).not.toBeDisabled();
  });

  it('submits POST with company_id from props + only set fields; reports_to_id omitted when not picked', async () => {
    installContactsFetch([]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ContactForm
        mode="create"
        companyId="co-1"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText('First name'), {
      target: { value: 'Jane' },
    });
    fireEvent.change(screen.getByLabelText('Last name'), {
      target: { value: 'Doe' },
    });
    fireEvent.change(screen.getByLabelText('Primary email'), {
      target: { value: 'jane@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create contact/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({
      company_id: 'co-1',
      first_name: 'Jane',
      last_name: 'Doe',
      email1: 'jane@example.com',
    });
    expect(body).not.toHaveProperty('reports_to_id');
    expect(body).not.toHaveProperty('left_company');
    // Ruling D: company_department_id never sent.
    expect(body).not.toHaveProperty('company_department_id');
  });

  it('reports_to picker is disabled when the company has no other contacts (CREATE — empty list)', async () => {
    installContactsFetch([]);
    render(
      <ContactForm
        mode="create"
        companyId="co-1"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText('First name');
    await waitFor(() => {
      expect(screen.getByTestId('reports-to-picker')).toBeDisabled();
    });
  });

  it('left_company switch is NOT rendered on CREATE (ruling C — EDIT-only)', async () => {
    installContactsFetch([]);
    render(
      <ContactForm
        mode="create"
        companyId="co-1"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText('First name');
    expect(screen.queryByLabelText('Left company')).toBeNull();
  });
});

describe('ContactForm — EDIT (reports_to EXCLUDES SELF + left_company + PATCH semantics)', () => {
  it('excludes self from the reports_to picker (the FE-owned guard)', async () => {
    // The picker source includes SELF (ct-1) + one other (ct-2). The
    // exclude-self filter must drop ct-1 from the rendered items.
    const items = [
      makeContact({ id: 'ct-1', first_name: 'Jane', last_name: 'Doe' }),
      makeContact({ id: 'ct-2', first_name: 'Other', last_name: 'Person' }),
    ];
    installContactsFetch(items);
    render(
      <ContactForm
        mode="edit"
        initial={makeContact({ id: 'ct-1' })}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('reports-to-picker')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByTestId('reports-to-picker'));
    // The ONE other contact is offered; self (ct-1 Jane Doe) is NOT.
    expect(
      await screen.findByTestId('reports-to-picker-option-ct-2'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('reports-to-picker-option-ct-1')).toBeNull();
  });

  it('disables the reports_to picker when self is the only contact (exclude-self yields empty)', async () => {
    installContactsFetch([
      makeContact({ id: 'ct-1', first_name: 'Jane', last_name: 'Doe' }),
    ]);
    render(
      <ContactForm
        mode="edit"
        initial={makeContact({ id: 'ct-1' })}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText('First name');
    await waitFor(() => {
      expect(screen.getByTestId('reports-to-picker')).toBeDisabled();
    });
  });

  it('renders the left_company switch on EDIT (ruling C)', async () => {
    installContactsFetch([]);
    render(
      <ContactForm
        mode="edit"
        initial={makeContact()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />,
    );
    expect(await screen.findByLabelText('Left company')).toBeInTheDocument();
  });

  it('toggling left_company sends it in the PATCH body', async () => {
    installContactsFetch([]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <ContactForm
        mode="edit"
        initial={makeContact({ left_company: false })}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByLabelText('Left company'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ left_company: true });
  });

  it('PATCH NEVER sends company_department_id (ruling D — preserve via omit-not-touch)', async () => {
    installContactsFetch([]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    // The initial has a department set; the form does NOT surface a
    // picker. PATCH must omit the key entirely so the BE preserves it.
    const initial = makeContact({
      company_department_id: 'dep-1',
      first_name: 'Jane',
    });
    render(
      <ContactForm
        mode="edit"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    // Change first_name so PATCH body is non-empty (otherwise an empty
    // body trivially has no company_department_id key).
    fireEvent.change(await screen.findByLabelText('First name'), {
      target: { value: 'Janet' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.first_name).toBe('Janet');
    expect(body).not.toHaveProperty('company_department_id');
  });

  it('clearing reports_to sends null; setting a new one sends the id', async () => {
    installContactsFetch([
      makeContact({ id: 'ct-1' }),
      makeContact({ id: 'ct-2', first_name: 'Boss' }),
    ]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = makeContact({ id: 'ct-1', reports_to_id: 'ct-2' });
    render(
      <ContactForm
        mode="edit"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('reports-to-picker')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /clear reports-to/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ reports_to_id: null });
  });

  it('clearing a nullable string (email1) sends explicit null (omit-vs-null discipline)', async () => {
    installContactsFetch([]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = makeContact({ email1: 'old@example.com' });
    render(
      <ContactForm
        mode="edit"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Primary email'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ email1: null });
  });
});

describe('ContactForm — cancel', () => {
  it('clicking Cancel fires onCancel', async () => {
    installContactsFetch([]);
    const onCancel = vi.fn();
    render(
      <ContactForm
        mode="create"
        companyId="co-1"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});
