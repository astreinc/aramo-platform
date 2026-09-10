import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentEditDrawer } from './TalentEditDrawer';
import type { TalentRecordView } from './types';

function makeTalent(overrides: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id: 'tal-1',
    tenant_id: 't',
    site_id: null,
    first_name: 'Ada',
    last_name: 'Lovelace',
    email1: 'ada@example.com',
    email2: null,
    phone_home: null,
    phone_cell: '555-0100',
    phone_work: null,
    address: null,
    address2: null,
    city: 'Austin',
    state: 'TX',
    zip: null,
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: '$95/hr',
    availability_status: 'available_now',
    engagement_type: 'contract',
    work_authorization: 'US_CITIZEN',
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function installFetch(map: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, value] of Object.entries(map)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(value), {
          status: (init?.method ?? 'GET') === 'PATCH' ? 200 : 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderDrawer(
  talent: TalentRecordView,
  onSaved = vi.fn(),
  onClose = vi.fn(),
) {
  render(
    <MemoryRouter>
      <TalentEditDrawer talent={talent} onSaved={onSaved} onClose={onClose} />
    </MemoryRouter>,
  );
  return { onSaved, onClose };
}

afterEach(() => vi.restoreAllMocks());

describe('TalentEditDrawer', () => {
  it('shows email + phone as READ-ONLY (no editable control) and the editable fields as inputs', () => {
    installFetch({});
    renderDrawer(makeTalent());
    // Read-only: value displayed, but there is NO form control labelled Email/Phone.
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('555-0100')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Email/)).toBeNull();
    expect(screen.queryByLabelText(/^Phone/)).toBeNull();
    // The read-only affordance is labelled.
    expect(screen.getAllByText('read-only').length).toBeGreaterThanOrEqual(2);
    // Editable fields carry the record values.
    expect((screen.getByLabelText(/First name/) as HTMLInputElement).value).toBe('Ada');
    expect((screen.getByLabelText(/City/) as HTMLInputElement).value).toBe('Austin');
    expect((screen.getByLabelText(/Work authorization/) as HTMLSelectElement).value).toBe(
      'US_CITIZEN',
    );
    expect((screen.getByLabelText(/Desired rate/) as HTMLInputElement).value).toBe('$95/hr');
  });

  it('saves editable fields via PATCH and hands the updated record back', async () => {
    const updated = makeTalent({ city: 'Dallas' });
    const fetchSpy = installFetch({ '/v1/talent-records/tal-1': updated });
    const { onSaved } = renderDrawer(makeTalent());
    fireEvent.change(screen.getByLabelText(/City/), { target: { value: 'Dallas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const patch = fetchSpy.mock.calls.find(
      (c) => String(c[0]).includes('/v1/talent-records/tal-1') && (c[1] as RequestInit)?.method === 'PATCH',
    );
    expect(patch).toBeDefined();
    const body = JSON.parse(String((patch?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.city).toBe('Dallas');
    expect(body.work_authorization).toBe('US_CITIZEN');
    // Read-only fields are NOT part of the patch.
    expect(body.email1).toBeUndefined();
    expect(body.phone_cell).toBeUndefined();
  });

  it('blocks save when a required field is empty (no PATCH fired)', async () => {
    const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    const { onSaved } = renderDrawer(makeTalent());
    // Clear a required field (desired rate).
    fireEvent.change(screen.getByLabelText(/Desired rate/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    // No PATCH, no onSaved.
    const patch = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patch).toBeUndefined();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('requires a work-authorization CHOICE but accepts NOT_DISCLOSED', async () => {
    const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderDrawer(makeTalent({ work_authorization: null }));
    // Unset work auth → blocked.
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'),
    ).toBeUndefined();
    // NOT_DISCLOSED is a valid explicit choice → save proceeds.
    fireEvent.change(screen.getByLabelText(/Work authorization/), {
      target: { value: 'NOT_DISCLOSED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'),
      ).toBeDefined(),
    );
  });

  it('lets the recruiter ENTER email + phone when the record is missing them, then PATCHes the values', async () => {
    const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderDrawer(
      makeTalent({ email1: null, phone_cell: null, phone_home: null, phone_work: null }),
    );
    // Missing → now editable controls exist.
    const email = screen.getByLabelText(/Email/);
    const phone = screen.getByLabelText(/Phone/);
    fireEvent.change(email, { target: { value: 'new@example.com' } });
    fireEvent.change(phone, { target: { value: '555-9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const patch = fetchSpy.mock.calls.find(
        (c) =>
          String(c[0]).includes('/v1/talent-records/tal-1') &&
          (c[1] as RequestInit)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      const body = JSON.parse(String((patch?.[1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.email1).toBe('new@example.com');
      expect(body.phone_cell).toBe('555-9999');
    });
  });

  it('rejects a badly-formatted email entered on a missing-email record (no PATCH)', () => {
    const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderDrawer(makeTalent({ email1: null }));
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'),
    ).toBeUndefined();
  });

  it('keeps the "Edit full profile" route link to the full workspace', () => {
    installFetch({});
    renderDrawer(makeTalent());
    const link = screen.getByRole('link', { name: /Edit full profile/ });
    expect(link).toHaveAttribute('href', '/talent/tal-1/edit');
  });
});
