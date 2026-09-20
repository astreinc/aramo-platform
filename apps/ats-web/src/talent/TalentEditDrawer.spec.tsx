import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TalentEditDrawer } from './TalentEditDrawer';
import type { TalentRecordView } from './types';

// The drawer reads `talent:edit:contact` off the session via the FE `hasScope`
// helper (useSession). Mock useSession only; keep the rest of the barrel real
// (Button/InlineAlert/hasScope come through @aramo/fe-foundation).
const useSession = vi.fn();
vi.mock('@aramo/fe-foundation', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useSession: () => useSession(),
}));

function withScopes(scopes: string[]): void {
  useSession.mockReturnValue({
    status: 'authenticated',
    session: { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 },
  });
}

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

beforeEach(() => {
  // Default: no contact-edit scope (recruiter tier) — preserves the
  // read-only-when-present behavior the pre-existing cases assert.
  useSession.mockReturnValue({ status: 'unauthenticated' });
});
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
    // TI-1G-P0 — only City changed; the UNTOUCHED work_authorization is OMITTED
    // (never re-sent), so opening + saving can't stamp a spurious explicit-clear.
    expect('work_authorization' in body).toBe(false);
    // Read-only fields are NOT part of the patch.
    expect(body.email1).toBeUndefined();
    expect(body.phone_cell).toBeUndefined();
  });

  it('blocks save when a required field is empty (no PATCH fired)', async () => {
    const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    const { onSaved } = renderDrawer(makeTalent());
    // Clear a still-required field (city).
    fireEvent.change(screen.getByLabelText(/City/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    // No PATCH, no onSaved.
    const patch = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patch).toBeUndefined();
    expect(onSaved).not.toHaveBeenCalled();
  });

  // Helper: fire Save and return the parsed PATCH body (or undefined if no PATCH).
  async function saveAndGetPatchBody(
    fetchSpy: ReturnType<typeof installFetch>,
  ): Promise<Record<string, unknown> | undefined> {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH'),
      ).toBeDefined(),
    );
    const patch = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
    );
    return patch ? (JSON.parse((patch[1] as RequestInit).body as string) as Record<string, unknown>) : undefined;
  }

  it('optional fields — save proceeds; desired rate empty → null', async () => {
    const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
    renderDrawer(makeTalent({ work_authorization: null }));
    fireEvent.change(screen.getByLabelText(/Desired rate/), { target: { value: '' } });
    const body = await saveAndGetPatchBody(fetchSpy);
    expect(body?.['desired_pay']).toBeNull();
  });

  // TI-1G-P0 — the untouched ≠ clear matrix. work_authorization is a
  // reconcile-covered field where a PATCH null is an EXPLICIT clear
  // (→ EXPLICITLY_CLEARED + HOLD). Opening + saving without touching it must
  // NEVER send it; an intentional clear MUST.
  describe('TI-1G-P0 — work_authorization untouched ≠ clear', () => {
    it('untouched (loaded null) → OMITTED from the PATCH (no spurious explicit-clear)', async () => {
      const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
      renderDrawer(makeTalent({ work_authorization: null }));
      fireEvent.change(screen.getByLabelText(/City/), { target: { value: 'Dallas' } });
      const body = await saveAndGetPatchBody(fetchSpy);
      expect('work_authorization' in (body ?? {})).toBe(false);
    });

    it('untouched (loaded value) → OMITTED from the PATCH (never re-sent)', async () => {
      const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
      renderDrawer(makeTalent({ work_authorization: 'VISA_HOLDER' }));
      fireEvent.change(screen.getByLabelText(/City/), { target: { value: 'Dallas' } });
      const body = await saveAndGetPatchBody(fetchSpy);
      expect('work_authorization' in (body ?? {})).toBe(false);
    });

    it('intentional clear (loaded value → empty) → work_authorization: null (EXPLICITLY_CLEARED)', async () => {
      const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
      renderDrawer(makeTalent({ work_authorization: 'VISA_HOLDER' }));
      fireEvent.change(screen.getByLabelText(/Work authorization/), { target: { value: '' } });
      const body = await saveAndGetPatchBody(fetchSpy);
      expect('work_authorization' in (body ?? {})).toBe(true);
      expect(body?.['work_authorization']).toBeNull();
    });

    it('new selection (loaded null → a value) → work_authorization: the value', async () => {
      const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
      renderDrawer(makeTalent({ work_authorization: null }));
      fireEvent.change(screen.getByLabelText(/Work authorization/), { target: { value: 'US_CITIZEN' } });
      const body = await saveAndGetPatchBody(fetchSpy);
      expect(body?.['work_authorization']).toBe('US_CITIZEN');
    });

    it('changed selection (loaded value → different value) → the new value', async () => {
      const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
      renderDrawer(makeTalent({ work_authorization: 'VISA_HOLDER' }));
      fireEvent.change(screen.getByLabelText(/Work authorization/), { target: { value: 'PERMANENT_RESIDENT' } });
      const body = await saveAndGetPatchBody(fetchSpy);
      expect(body?.['work_authorization']).toBe('PERMANENT_RESIDENT');
    });
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

  describe('contact-anchor edit gate (talent:edit:contact)', () => {
    it('WITHOUT the scope: a PRESENT email + phone render read-only (today\'s behavior)', () => {
      // Default beforeEach = unauthenticated → canEditContact false.
      installFetch({});
      renderDrawer(makeTalent());
      expect(screen.getByText('ada@example.com')).toBeInTheDocument();
      expect(screen.getByText('555-0100')).toBeInTheDocument();
      // No editable Email/Phone control exists.
      expect(screen.queryByLabelText(/^Email/)).toBeNull();
      expect(screen.queryByLabelText(/^Phone/)).toBeNull();
      expect(screen.getAllByText('read-only').length).toBeGreaterThanOrEqual(2);
    });

    it('WITH the scope: a PRESENT email + phone render as EDITABLE inputs and a changed value is PATCHed', async () => {
      withScopes(['talent:edit', 'talent:edit:contact']);
      const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
      renderDrawer(makeTalent());
      // Present values are now editable controls pre-filled with the record value.
      const email = screen.getByLabelText(/Email/) as HTMLInputElement;
      const phone = screen.getByLabelText(/Phone/) as HTMLInputElement;
      expect(email.value).toBe('ada@example.com');
      expect(phone.value).toBe('555-0100');
      // No read-only affordance in the CONTACT section when privileged.
      expect(screen.queryByText('read-only')).toBeNull();
      // Change the email; leave the phone unchanged.
      fireEvent.change(email, { target: { value: 'ada.new@example.com' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => {
        const patch = fetchSpy.mock.calls.find(
          (c) =>
            String(c[0]).includes('/v1/talent-records/tal-1') &&
            (c[1] as RequestInit)?.method === 'PATCH',
        );
        expect(patch).toBeDefined();
        const body = JSON.parse(String((patch?.[1] as RequestInit).body)) as Record<string, unknown>;
        // Changed anchor is sent; the UNCHANGED phone is NOT re-sent.
        expect(body.email1).toBe('ada.new@example.com');
        expect(body).not.toHaveProperty('phone_cell');
      });
    });

    it('WITH the scope: a blanked present anchor is OMITTED from the PATCH (backend rejects blank)', async () => {
      withScopes(['talent:edit', 'talent:edit:contact']);
      const fetchSpy = installFetch({ '/v1/talent-records/tal-1': makeTalent() });
      renderDrawer(makeTalent());
      fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => {
        const patch = fetchSpy.mock.calls.find(
          (c) =>
            String(c[0]).includes('/v1/talent-records/tal-1') &&
            (c[1] as RequestInit)?.method === 'PATCH',
        );
        expect(patch).toBeDefined();
        const body = JSON.parse(String((patch?.[1] as RequestInit).body)) as Record<string, unknown>;
        expect(body).not.toHaveProperty('phone_cell');
        expect(body).not.toHaveProperty('email1');
      });
    });
  });
});
