import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentEditView } from './TalentEditView';

// The full-profile EDIT now reuses the Add-Talent Step-2 layout (IntakeForm),
// pre-filled from the stored record. Quick-Edit rules apply: email + phone are
// identity anchors (read-only); key_skills AND work-history are editable
// (replace-set). PATCH → detail.

function installFetch(
  handler: (req: { url: string; method: string; body: unknown }) =>
    | { status: number; body: unknown },
) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = init?.method ?? 'GET';
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, body });
    const res = handler({ url, method, body });
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return calls;
}

function makeTalent() {
  return {
    id: 'tal-42',
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
    city: 'London',
    state: 'LDN',
    zip: null,
    country: 'US',
    source: null,
    key_skills: 'Bernoulli numbers',
    current_employer: 'Analytical Engines',
    current_pay: null,
    desired_pay: '$100/hr',
    availability_status: null,
    engagement_type: null,
    work_authorization: null,
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
  };
}

const WORK_HISTORY = [
  {
    id: 'wh-1',
    employer_name: 'Analytical Engines',
    role_title: 'Mathematician',
    start_date: '1842-01-01',
    end_date: null,
    employment_type: null,
    description: null,
    source: 'resume',
    verified: false,
  },
];

// Default handler: GET detail, GET work-history, PATCH echo.
function routeHandler(req: { url: string; method: string }) {
  if (req.method === 'GET' && req.url.includes('/work-history')) {
    return { status: 200, body: { work_history: WORK_HISTORY } };
  }
  if (req.method === 'GET' && req.url.includes('/resume-editions')) {
    return { status: 200, body: { talent_id: 'tal-42', editions: [] } };
  }
  if (req.method === 'GET' && req.url.includes('/v1/talent-records/tal-42')) {
    return { status: 200, body: makeTalent() };
  }
  if (req.method === 'PATCH' && req.url.includes('/v1/talent-records/tal-42')) {
    return { status: 200, body: { ...makeTalent(), is_hot: true } };
  }
  return { status: 404, body: {} };
}

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/talent/tal-42/edit']}>
      <Routes>
        <Route path="/talent/:talentId/edit" element={<TalentEditView />} />
        <Route path="/talent/:id" element={<p data-testid="detail">talent detail</p>} />
        <Route path="/talent" element={<p data-testid="list">talent list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TalentEditView', () => {
  it('pre-fills the Step-2 form; email + phone are read-only anchors; shows the résumé-editions panel + Add résumé', async () => {
    installFetch(routeHandler);
    renderAt();
    await waitFor(() =>
      expect(screen.getByText(/Edit: Ada Lovelace/)).toBeInTheDocument(),
    );
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada');
    expect((screen.getByLabelText('Key skills') as HTMLTextAreaElement).value).toBe(
      'Bernoulli numbers',
    );
    // Identity anchors are rendered read-only.
    const email = screen.getByLabelText('Primary email') as HTMLInputElement;
    expect(email.value).toBe('ada@example.com');
    expect(email.readOnly).toBe(true);
    const phone = screen.getByLabelText('Mobile') as HTMLInputElement;
    expect(phone.readOnly).toBe(true);
    // TI-1D-C — the résumé-editions panel (the resume-editions fetch 404s in this
    // default mock → the panel shows its no-editions fallback + Add résumé).
    await waitFor(() => expect(screen.getByText('Résumé editions')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Add résumé/ })).toBeInTheDocument();
  });

  it('TI-1D-C — lists editions with the EXPLICIT default (not latest-wins); selecting/defaulting never PATCHes the talent', async () => {
    const calls = installFetch((req) => {
      if (req.method === 'GET' && req.url.includes('/resume-editions')) {
        return {
          status: 200,
          body: {
            talent_id: 'tal-42',
            editions: [
              // newest-first; ED_B (newer) is NOT the default.
              { edition_id: 'ed-b', talent_document_id: 'd-b', attachment_id: null, purpose: 'CLIENT_SUBMITTAL', label: 'GenAI', lifecycle_status: 'active', created_at: '2026-07-05T00:00:00Z', filename: 'genai.docx', mime_type: 'x', uploaded_at: '2026-07-05T00:00:00Z', is_default: false, processing_status: null },
              { edition_id: 'ed-a', talent_document_id: 'd-a', attachment_id: null, purpose: 'GENERAL', label: null, lifecycle_status: 'active', created_at: '2026-07-01T00:00:00Z', filename: 'general.pdf', mime_type: 'y', uploaded_at: '2026-07-01T00:00:00Z', is_default: true, processing_status: null },
            ],
          },
        };
      }
      if (req.method === 'PUT' && req.url.includes('/resume-editions/default')) {
        return { status: 200, body: { talent_id: 'tal-42', editions: [] } };
      }
      return routeHandler(req);
    });
    renderAt();
    // Both editions are listed; the explicit default (older ED_A) carries "Default",
    // the newer ED_B offers "Make default" — never latest-wins.
    await waitFor(() => expect(screen.getByText(/general.pdf/)).toBeInTheDocument());
    expect(screen.getByText(/genai.docx/)).toBeInTheDocument();
    const makeDefault = screen.getByRole('button', { name: /Make default/ });
    fireEvent.click(makeDefault);
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/resume-editions/default'));
      expect(put?.body).toMatchObject({ resume_edition_id: 'ed-b' });
    });
    // Presentation-only: selecting/defaulting an edition NEVER PATCHes the talent
    // (no silent provenance/truth change).
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('submits a PATCH (true PATCH — only changed scalar) and navigates to detail; work_history omitted when untouched', async () => {
    const calls = installFetch(routeHandler);
    renderAt();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Hot talent'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall).toBeDefined();
    // Only the changed scalar — work_history NOT sent (section untouched).
    expect(patchCall?.body).toEqual({ is_hot: true });
  });

  it('sends the reviewed work-history (replace-set) when the recruiter edits it', async () => {
    const calls = installFetch(routeHandler);
    renderAt();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());
    // Edit the existing work-history row's role → marks the section dirty.
    fireEvent.change(screen.getByLabelText('Role title 1'), {
      target: { value: 'Lead Mathematician' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.body).toEqual({
      work_history: [
        { employer_name: 'Analytical Engines', role_title: 'Lead Mathematician', start_date: '1842-01-01' },
      ],
    });
  });

  it('surfaces a friendly error when the pre-fetch returns 404', async () => {
    installFetch(() => ({ status: 404, body: { message: 'not found' } }));
    renderAt();
    await waitFor(() =>
      expect(
        screen.getByText(/this talent record is not available/i),
      ).toBeInTheDocument(),
    );
  });
});
