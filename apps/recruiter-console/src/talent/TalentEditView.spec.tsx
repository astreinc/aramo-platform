import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TalentEditView } from './TalentEditView';

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
    phone_cell: null,
    phone_work: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    source: null,
    key_skills: 'Bernoulli numbers',
    current_employer: 'Analytical Engines',
    current_pay: null,
    desired_pay: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    core_talent_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  };
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
  it('pre-fetches + renders the form with values pre-filled; no résumé upload section', async () => {
    installFetch((req) => {
      if (req.url.includes('/v1/talent-records/tal-42') && req.method === 'GET') {
        return { status: 200, body: makeTalent() };
      }
      return { status: 404, body: {} };
    });
    renderAt();
    await waitFor(() =>
      expect(screen.getByText(/Edit: Ada Lovelace/)).toBeInTheDocument(),
    );
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada');
    expect((screen.getByLabelText('Key skills') as HTMLTextAreaElement).value).toBe(
      'Bernoulli numbers',
    );
    // NO résumé upload section in EDIT.
    expect(screen.queryByTestId('resume-upload-section')).toBeNull();
    expect(screen.queryByText(/upload résumé/i)).toBeNull();
  });

  it('submits a PATCH (true PATCH — only changed fields) and navigates to detail', async () => {
    const calls = installFetch((req) => {
      if (req.url.includes('/v1/talent-records/tal-42') && req.method === 'GET') {
        return { status: 200, body: makeTalent() };
      }
      if (req.url.includes('/v1/talent-records/tal-42') && req.method === 'PATCH') {
        return { status: 200, body: { ...makeTalent(), is_hot: true } };
      }
      return { status: 404, body: {} };
    });
    renderAt();
    await waitFor(() =>
      expect(screen.getByLabelText('First name')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText('Hot'));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(screen.getByTestId('detail')).toBeInTheDocument());
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall?.body).toEqual({ is_hot: true });
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
