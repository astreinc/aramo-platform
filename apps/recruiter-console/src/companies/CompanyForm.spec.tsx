import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompanyForm } from './CompanyForm';
import type { CompanyView, ContactView } from './types';

// R6' — the company mutate form specs. Covers ruling B (billing_contact
// EDIT-only / absent on CREATE), ruling A (More-fields collapse + tiered),
// the R4 PATCH-omit-vs-null discipline, and validation.

function makeCompany(overrides: Partial<CompanyView> = {}): CompanyView {
  return {
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
    // Company-Fields v1.1 — un-gated additive (default-equivalent values so a
    // no-change EDIT still produces an empty PATCH).
    status: 'active',
    description: null,
    industry: null,
    country: null,
    employee_count_band: null,
    annual_revenue_band: null,
    founded_year: null,
    ownership_type: null,
    registration_number: null,
    source: null,
    client_tier: null,
    supplier_status: null,
    exclusivity: false,
    tags: [],
    general_email: null,
    last_activity_at: null,
    next_action_at: null,
    ...overrides,
  };
}

function makeContact(
  id: string,
  first: string,
  last: string,
  companyId: string,
): ContactView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    first_name: first,
    last_name: last,
    title: null,
    email1: null,
    email2: null,
    phone_work: null,
    phone_cell: null,
    phone_other: null,
    address: null,
    company_id: companyId,
    company_department_id: null,
    is_hot: false,
    notes: null,
    left_company: false,
    reports_to_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  };
}

interface MockedRequest {
  readonly url: string;
  readonly method: string;
}

function installFetch(items: readonly ContactView[] = []): MockedRequest[] {
  const calls: MockedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/v1/contacts')) {
      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // Company-Fields v1.1 — the EDIT-mode departments editor fetches this.
    if (url.includes('/departments')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200 });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CompanyForm — CREATE (ruling B: billing_contact_id absent)', () => {
  it('does not render the billing contact picker on CREATE (chicken-and-egg)', async () => {
    installFetch();
    render(
      <CompanyForm
        mode="create"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    await screen.findByLabelText('Name');
    expect(screen.queryByTestId('billing-contact-picker')).toBeNull();
    expect(screen.queryByLabelText('Billing contact')).toBeNull();
  });

  it('disables submit until the required name is set', async () => {
    installFetch();
    render(
      <CompanyForm
        mode="create"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    const submit = await screen.findByRole('button', { name: /create company/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NewCo' } });
    expect(submit).not.toBeDisabled();
  });

  it('submits POST body with only set fields; omits unset optional strings + billing_contact_id', async () => {
    installFetch();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanyForm
        mode="create"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'NewCo' },
    });
    fireEvent.change(screen.getByLabelText('Phone'), {
      target: { value: '555-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create company/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    // Company-Fields v1.1 — country defaults to 'US' (the directive default),
    // so it rides along on every create; status stays at its DB default
    // ('active') so it is NOT sent.
    expect(body).toEqual({ name: 'NewCo', phone1: '555-1234', country: 'US' });
    expect(body).not.toHaveProperty('billing_contact_id');
    expect(body).not.toHaveProperty('address');
    expect(body).not.toHaveProperty('is_hot');
    expect(body).not.toHaveProperty('status');
  });

  it('More fields disclosure is hidden by default and reveals additional inputs when opened', async () => {
    installFetch();
    render(
      <CompanyForm
        mode="create"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    await screen.findByLabelText('Name');
    const summary = screen.getByText('More fields');
    // The summary is present; the details element is collapsed by default.
    expect(summary).toBeInTheDocument();
    const details = summary.closest('details') as HTMLDetailsElement | null;
    expect(details?.open).toBe(false);
    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(screen.getByLabelText('Address')).toBeInTheDocument();
    expect(screen.getByLabelText('Zip')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone (secondary)')).toBeInTheDocument();
  });
});

describe('CompanyForm — EDIT (PATCH omit-vs-null + billing_contact_id)', () => {
  it('pre-fills from initial; submit with no changes sends an empty PATCH body', async () => {
    installFetch();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = makeCompany({
      name: 'Acme',
      url: 'https://acme.example',
    });
    render(
      <CompanyForm
        mode="edit"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(name.value).toBe('Acme');
    expect((screen.getByLabelText('Website') as HTMLInputElement).value).toBe(
      'https://acme.example',
    );
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(body)).toHaveLength(0);
  });

  it('clearing a nullable string sends explicit null (omit-vs-null discipline)', async () => {
    installFetch();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = makeCompany({ url: 'https://acme.example' });
    render(
      <CompanyForm
        mode="edit"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Website'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ url: null });
  });

  it('renders the billing contact picker on EDIT (ruling B)', async () => {
    installFetch([
      makeContact('ct-1', 'Bill', 'Payer', 'co-1'),
      makeContact('ct-2', 'Other', 'One', 'co-1'),
    ]);
    render(
      <CompanyForm
        mode="edit"
        initial={makeCompany()}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('billing-contact-picker')).not.toBeDisabled();
    });
  });

  it('selecting a billing contact PATCHes billing_contact_id; clearing it sends null', async () => {
    installFetch([
      makeContact('ct-1', 'Bill', 'Payer', 'co-1'),
    ]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = makeCompany({ billing_contact_id: 'ct-old' });
    render(
      <CompanyForm
        mode="edit"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('billing-contact-picker')).not.toBeDisabled();
    });
    fireEvent.click(screen.getByRole('button', { name: /clear billing contact/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ billing_contact_id: null });
  });

  it('toggling is_hot changes the PATCH but does not emit unrelated keys', async () => {
    installFetch();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const initial = makeCompany({ is_hot: false });
    render(
      <CompanyForm
        mode="edit"
        initial={initial}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      canSeeCommercial={false}
      />,
    );
    fireEvent.click(await screen.findByLabelText('Hot'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).toEqual({ is_hot: true });
  });
});

describe('CompanyForm — cancel + submitting state', () => {
  it('clicking Cancel fires onCancel', async () => {
    installFetch();
    const onCancel = vi.fn();
    render(
      <CompanyForm
        mode="create"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      canSeeCommercial={false}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders the parent-provided submitError', async () => {
    installFetch();
    render(
      <CompanyForm
        mode="create"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        submitError="The field &quot;name&quot; has an invalid value. Please check and try again."
      canSeeCommercial={false}
      />,
    );
    expect(
      await screen.findByText(/the field "name" has an invalid value/i),
    ).toBeInTheDocument();
  });
});

describe('CompanyForm — Company-Fields v1.1 commercial gating', () => {
  it('does NOT render the commercial section when canSeeCommercial is false', async () => {
    installFetch();
    render(
      <CompanyForm
        mode="create"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        canSeeCommercial={false}
      />,
    );
    await screen.findByLabelText('Name');
    expect(screen.queryByText('Commercial defaults')).toBeNull();
    expect(screen.queryByLabelText('Default contract markup %')).toBeNull();
    expect(screen.queryByLabelText('Fee model')).toBeNull();
  });

  it('renders the commercial section AND includes its fields in the CREATE body when canSeeCommercial is true', async () => {
    installFetch();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <CompanyForm
        mode="create"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        canSeeCommercial={true}
      />,
    );
    fireEvent.change(await screen.findByLabelText('Name'), {
      target: { value: 'NewCo' },
    });
    const markup = screen.getByLabelText('Default contract markup %');
    fireEvent.change(markup, { target: { value: '25.00' } });
    fireEvent.change(screen.getByLabelText('Fee model'), {
      target: { value: 'contract' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create company/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['default_contract_markup_pct']).toBe('25.00');
    expect(body['fee_model']).toBe('contract');
  });

  it('surfaces the un-gated Profile/Firmographics/Relationship fields (e.g. Industry, Country, Client tier)', async () => {
    installFetch();
    render(
      <CompanyForm
        mode="create"
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        canSeeCommercial={false}
      />,
    );
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByText('More fields'));
    expect(screen.getByLabelText('Industry')).toBeInTheDocument();
    expect(screen.getByLabelText('Country')).toBeInTheDocument();
    expect(screen.getByLabelText('Client tier')).toBeInTheDocument();
  });
});
