import {
  fireEvent,
  render as rawRender,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, type Session } from '@aramo/fe-foundation';

import type { CompanyView, ContactView } from '../companies/types';

import { RequisitionForm } from './RequisitionForm';
import type { RequisitionStatus, RequisitionView } from './types';

// PR-A2 P4 — the form is create-only now; the ToastProvider wrapper is kept
// (harmless) for parity with the app root, which always provides it.
function render(ui: ReactElement) {
  return rawRender(<ToastProvider>{ui}</ToastProvider>);
}

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

function makeCompany(id: string, name: string): CompanyView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    name,
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

function makeReq(
  overrides: Partial<RequisitionView> = {},
): RequisitionView {
  return {
    id: 'req-1',
    tenant_id: 't',
    site_id: null,
    title: 'Senior Engineer',
    company_id: 'co-1',
    contact_id: null,
    company_department_id: null,
    status: 'active' as RequisitionStatus,
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
    job_type: null,
    labor_category: null,
    role_family: null,
    seniority_level: null,
    headcount_reason: null,
    work_arrangement: null,
    travel_percent: null,
    relocation_offered: null,
    work_authorization: null,
    end_date: null,
    duration_value: null,
    duration_unit: null,
    extension_possible: null,
    hours_per_week: null,
    source_system: null,
    external_req_id: null,
    imported_at: null,
    target_margin_percent: null,
    markup_percent_target: null,
    rate_card_id: null,
    min_bill_rate: null,
    max_bill_rate: null,
    min_pay_rate: null,
    max_pay_rate: null,
    golden_profile_id: null,
    ...overrides,
  };
}

interface MockedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function installFetch(
  handler: (req: MockedRequest) =>
    | { status: number; body: unknown }
    | Promise<{ status: number; body: unknown }>,
): MockedRequest[] {
  const calls: MockedRequest[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (init?.body !== undefined && init.body !== null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    const req: MockedRequest = { url, method, body };
    calls.push(req);
    const res = await handler(req);
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const COMPANIES = [makeCompany('co-1', 'Acme Corp'), makeCompany('co-2', 'Other Co')];
const CONTACTS_CO1 = [makeContact('ct-1', 'Jane', 'Doe', 'co-1')];

describe('RequisitionForm — CREATE', () => {
  it('renders the basics + disables submit until title + company are set', async () => {
    installFetch((req) => {
      if (req.url.includes('/v1/companies')) {
        return { status: 200, body: { items: COMPANIES } };
      }
      return { status: 200, body: { items: [] } };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const submit = await screen.findByRole('button', { name: /create requisition/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New Role' } });
    // Still disabled (no company picked).
    expect(submit).toBeDisabled();
  });

  it('submits POST with the basics; no compensation when the actor has no view scopes (D5 hidden section)', async () => {
    const onSuccess = vi.fn();
    const calls = installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      if (req.url.includes('/v1/contacts') && req.method === 'GET') {
        return { status: 200, body: { items: CONTACTS_CO1 } };
      }
      if (req.url === '/v1/requisitions' && req.method === 'POST') {
        return { status: 201, body: makeReq() };
      }
      return { status: 404, body: {} };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );
    // Compensation section is hidden (no view scopes).
    await waitFor(() => {
      expect(screen.queryByText('Compensation')).toBeNull();
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New Role' } });
    // Pick company via the Combobox.
    fireEvent.click(screen.getByTestId('company-picker'));
    fireEvent.click(await screen.findByTestId('company-picker-option-co-1'));
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.body).toMatchObject({
      title: 'New Role',
      company_id: 'co-1',
      openings: 1,
    });
    // No compensation fields in the body (no view scopes → none visible).
    const body = postCall?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('compensation_model');
    expect(body).not.toHaveProperty('pay_rate_amount');
    expect(body).not.toHaveProperty('salary_amount');
  });

  it('CREATE with compensation:view:pay + CONTRACT discriminator sends ONLY on-branch+visible comp', async () => {
    const onSuccess = vi.fn();
    const calls = installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      if (req.url.includes('/v1/contacts') && req.method === 'GET') {
        return { status: 200, body: { items: [] } };
      }
      if (req.url === '/v1/requisitions' && req.method === 'POST') {
        return { status: 201, body: makeReq() };
      }
      return { status: 404, body: {} };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create', 'compensation:view:pay'])}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );
    // Wait for companies to load (so the picker is enabled). Without
    // this, clicking the picker too early can race with Radix Popover
    // state and leave the popover closed.
    await waitFor(() => {
      expect(screen.getByTestId('company-picker')).not.toBeDisabled();
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Contract Role' } });
    fireEvent.click(screen.getByTestId('company-picker'));
    fireEvent.click(await screen.findByTestId('company-picker-option-co-1'));
    // Choose CONTRACT discriminator.
    fireEvent.click(screen.getByLabelText('Contract'));
    fireEvent.change(screen.getByLabelText('Pay rate amount'), {
      target: { value: '60.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    // On-branch + visible only: pay_rate_amount is visible under view:pay.
    expect(body).toMatchObject({
      compensation_model: 'CONTRACT',
      pay_rate_amount: '60.00',
    });
    // bill_rate_amount is on the CONTRACT branch but the actor lacks
    // view:bill — NOT sent (D5 defensive FE — ruling 1).
    expect(body).not.toHaveProperty('bill_rate_amount');
    // PERMANENT-side off-branch never sent.
    expect(body).not.toHaveProperty('salary_amount');
    expect(body).not.toHaveProperty('placement_fee_amount');
  });
});

// PR-A2 P4 — the EDIT-mode describe block (PATCH semantics + the D5
// no-blanking PATCH safety + the discriminator-flip cases) was REMOVED with
// the form's edit-mode. Editing is now INLINE in the cockpit, and the
// per-field PATCH + the backend-is-truth gate are proven there
// (RequisitionDetailView.cockpit.spec.tsx). The form is create-only.

describe('RequisitionForm — submit errors', () => {
  it('surfaces a friendly message when the BE returns 400 VALIDATION_ERROR with a field', async () => {
    installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      if (req.url.includes('/v1/contacts')) {
        return { status: 200, body: { items: [] } };
      }
      if (req.method === 'POST') {
        return {
          status: 400,
          body: {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid pay_rate_amount',
              details: { field: 'pay_rate_amount' },
            },
          },
        };
      }
      return { status: 404, body: {} };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create', 'compensation:view:pay'])}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('company-picker')).not.toBeDisabled();
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('company-picker'));
    fireEvent.click(await screen.findByTestId('company-picker-option-co-1'));
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/the field "pay_rate_amount" has an invalid value/i),
      ).toBeInTheDocument();
    });
  });

  it('surfaces a permission message on 403', async () => {
    installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      if (req.url.includes('/v1/contacts')) {
        return { status: 200, body: { items: [] } };
      }
      if (req.method === 'POST') {
        return { status: 403, body: { message: 'forbidden' } };
      }
      return { status: 404, body: {} };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('company-picker')).not.toBeDisabled();
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('company-picker'));
    fireEvent.click(await screen.findByTestId('company-picker-option-co-1'));
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/do not have permission to create requisitions/i),
      ).toBeInTheDocument();
    });
  });
});

describe('RequisitionForm — pickers', () => {
  it('contact picker is disabled until a company is chosen', async () => {
    installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      return { status: 200, body: { items: [] } };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByRole('combobox', { name: 'Company' });
    const contactBtn = screen.getByRole('combobox', { name: 'Contact' });
    expect(contactBtn).toBeDisabled();
  });

  it('shows the company-picker limitation banner when the visible-companies list hits the 50 cap', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) =>
      makeCompany(`co-${i}`, `Co ${i}`),
    );
    installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: fifty } };
      }
      return { status: 200, body: { items: [] } };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])}
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/showing first 50 visible companies/i),
      ).toBeInTheDocument();
    });
  });
});

describe('RequisitionForm — cancel', () => {
  it('clicking Cancel fires onCancel', async () => {
    const onCancel = vi.fn();
    installFetch(() => ({ status: 200, body: { items: [] } }));
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])}
        onSuccess={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('RequisitionForm — enterprise fields (Job-Module, UN-gated)', () => {
  it('threads enterprise fields (select / number / boolean) into the CREATE body', async () => {
    const onSuccess = vi.fn();
    const calls = installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      if (req.url.includes('/v1/contacts')) {
        return { status: 200, body: { items: [] } };
      }
      if (req.url === '/v1/requisitions' && req.method === 'POST') {
        return { status: 201, body: makeReq() };
      }
      return { status: 404, body: {} };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('company-picker')).not.toBeDisabled();
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Ent Role' } });
    fireEvent.click(screen.getByTestId('company-picker'));
    fireEvent.click(await screen.findByTestId('company-picker-option-co-1'));
    // Closed vocab via native select.
    fireEvent.change(screen.getByLabelText('Job type'), {
      target: { value: 'contract_to_hire' },
    });
    fireEvent.change(screen.getByLabelText('Role family'), {
      target: { value: 'backend_engineer' },
    });
    // Number field.
    fireEvent.change(screen.getByLabelText('Travel percent'), { target: { value: '25' } });
    // Boolean switch.
    fireEvent.click(screen.getByLabelText('Relocation offered'));
    // Text field.
    fireEvent.change(screen.getByLabelText('External req ID'), {
      target: { value: 'EXT-9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      job_type: 'contract_to_hire',
      role_family: 'backend_engineer',
      travel_percent: 25,
      relocation_offered: true,
      external_req_id: 'EXT-9',
    });
    // Unset selects/numbers/booleans are omitted.
    expect(body).not.toHaveProperty('seniority_level');
    expect(body).not.toHaveProperty('duration_value');
    expect(body).not.toHaveProperty('extension_possible');
  });
});

describe('RequisitionForm — financial planning (gated)', () => {
  it('HIDES the financial section + omits its fields when the actor lacks requisition:view:financials', async () => {
    const onSuccess = vi.fn();
    const calls = installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      if (req.url.includes('/v1/contacts')) {
        return { status: 200, body: { items: [] } };
      }
      if (req.method === 'POST') return { status: 201, body: makeReq() };
      return { status: 404, body: {} };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create'])} // no financials scope
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('company-picker')).not.toBeDisabled();
    });
    // Section is hidden.
    expect(screen.queryByText(/Financial planning/i)).toBeNull();
    expect(screen.queryByLabelText('Target margin percent')).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('company-picker'));
    fireEvent.click(await screen.findByTestId('company-picker-option-co-1'));
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('target_margin_percent');
    expect(body).not.toHaveProperty('min_bill_rate');
    expect(body).not.toHaveProperty('rate_card_id');
  });

  it('RENDERS the financial section + threads its fields when the actor holds requisition:view:financials', async () => {
    const onSuccess = vi.fn();
    const calls = installFetch((req) => {
      if (req.url.includes('/v1/companies') && req.method === 'GET') {
        return { status: 200, body: { items: COMPANIES } };
      }
      if (req.url.includes('/v1/contacts')) {
        return { status: 200, body: { items: [] } };
      }
      if (req.method === 'POST') return { status: 201, body: makeReq() };
      return { status: 404, body: {} };
    });
    render(
      <RequisitionForm
        session={makeSession(['requisition:create', 'requisition:view:financials'])}
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('company-picker')).not.toBeDisabled();
    });
    expect(screen.getByLabelText('Target margin percent')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('company-picker'));
    fireEvent.click(await screen.findByTestId('company-picker-option-co-1'));
    fireEvent.change(screen.getByLabelText('Target margin percent'), {
      target: { value: '32.5' },
    });
    fireEvent.change(screen.getByLabelText('Min bill rate'), {
      target: { value: '90.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create requisition/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const body = calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      target_margin_percent: '32.5',
      min_bill_rate: '90.00',
    });
    // Untouched financial fields omitted.
    expect(body).not.toHaveProperty('max_pay_rate');
  });
});

// PR-A2 P4 — the in-form "AI profile surface" describe block was REMOVED.
// The GoldenProfile workbench moved to the cockpit's persistent
// ProfileWorkbenchPanel (proven in ProfileWorkbenchPanel.spec.tsx); the
// transient GenerateProfileDialog was retired.
