import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@aramo/fe-foundation';

import { TalentCreateView } from './TalentCreateView';

// ATS-QA-1 I-3 (Durable-Async I7 / §8.5 conformance) + I-2 row A1 — the
// Add-Talent review form:
//   • sends work_history / education / certifications ONLY when the recruiter
//     edited them (never skills), so a save cannot wipe extracted evidence;
//   • a 409 before create refetches the authoritative draft and re-sends the
//     recruiter's edits against the new version before promoting;
//   • a failed save stops the create (never promotes without the edits);
//   • a late extraction fills untouched fields + arrays and keeps recruiter edits;
//   • City and State are optional: no required marker, no "/5 required" count.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const BASE_DRAFT = {
  id: 'd1',
  source_filename: 'ada.pdf',
  mime_type: 'application/pdf',
  size_bytes: 1024,
  processing_status: 'READY',
  review_status: 'IN_REVIEW',
  structured_payload: null,
  review_payload: {
    fields: {
      first_name: { value: 'Ada', origin: 'RESUME_EXTRACTION' },
      last_name: { value: 'Lovelace', origin: 'RESUME_EXTRACTION' },
      email1: { value: 'ada@example.com', origin: 'RESUME_EXTRACTION' },
      phone_cell: { value: '+15551230000', origin: 'RESUME_EXTRACTION' },
    },
    work_history: [{ employer_name: 'Initech', role_title: 'Analyst' }],
    education: [{ institution_name: 'State University', degree_name: 'BSc' }],
    skills: [{ surface_form: 'Java', source_refs: ['B001'] }],
    array_origin: { work_history: 'RESUME_EXTRACTION', education: 'RESUME_EXTRACTION' },
  },
  warning: null,
  failure: null,
  promoted_talent_record_id: null,
  version: 2,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  processing_completed_at: null,
  actions: ['edit_draft', 'promote_to_talent'],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function renderDraft() {
  return render(
    <MemoryRouter initialEntries={['/talent/new?draft=d1']}>
      <ToastProvider>
        <TalentCreateView />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('TalentCreateView — draft integrity (ATS-QA-1 I-3)', () => {
  let calls: Call[];
  let getDraft: () => unknown;
  let patchResponses: Array<() => Response>;

  beforeEach(() => {
    calls = [];
    getDraft = () => BASE_DRAFT;
    patchResponses = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.includes('/me')) return Promise.resolve(jsonResponse({}, 404));
      if (url.includes('duplicate-check')) return Promise.resolve(jsonResponse({ match: null }));
      if (url.includes('/promote')) {
        return Promise.resolve(jsonResponse({ id: 't1', first_name: 'Ada', last_name: 'Lovelace' }, 201));
      }
      if (url.endsWith('/v1/talent-intake-drafts/d1') && method === 'PATCH') {
        const next = patchResponses.shift();
        if (next !== undefined) return Promise.resolve(next());
        const expected = (body as { expected_version: number }).expected_version;
        return Promise.resolve(jsonResponse({ ...BASE_DRAFT, version: expected + 1 }));
      }
      if (url.includes('/v1/talent-intake-drafts/d1') && method === 'GET') {
        return Promise.resolve(jsonResponse(getDraft()));
      }
      return Promise.resolve(jsonResponse({}, 200));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const patches = () => calls.filter((c) => c.method === 'PATCH');
  const promoted = () => calls.some((c) => c.url.includes('/promote'));

  it('a scalar-only edit saves WITHOUT any evidence array or skills (extracted arrays are never sent back)', async () => {
    renderDraft();
    await waitFor(() => expect(screen.getByDisplayValue('Ada')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Professional title'), { target: { value: 'Engineer' } });
    fireEvent.click(screen.getByRole('button', { name: /Create talent/ }));
    await waitFor(() => expect(promoted()).toBe(true));
    const body = patches()[0]?.body as Record<string, unknown>;
    expect(body).toBeDefined();
    const review = body['review'] as Record<string, unknown>;
    expect(review['fields']).toMatchObject({ title: { value: 'Engineer', origin: 'RECRUITER' } });
    expect('work_history' in review).toBe(false);
    expect('education' in review).toBe(false);
    expect('certifications' in review).toBe(false);
    expect('skills' in review).toBe(false);
  });

  it('editing work history sends work_history (recruiter-owned) and nothing else array-shaped', async () => {
    renderDraft();
    await waitFor(() => expect(screen.getByDisplayValue('Initech')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Role title 1'), { target: { value: 'Senior Analyst' } });
    fireEvent.click(screen.getByRole('button', { name: /Create talent/ }));
    await waitFor(() => expect(promoted()).toBe(true));
    const review = (patches()[0]?.body as { review: Record<string, unknown> }).review;
    expect(review['work_history']).toEqual([{ employer_name: 'Initech', role_title: 'Senior Analyst' }]);
    expect('education' in review).toBe(false);
    expect('skills' in review).toBe(false);
  });

  it('a stale save (409) refetches, re-sends the edits on the new version, then promotes — extracted work history stays', async () => {
    patchResponses.push(() =>
      jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'changed' } }, 409),
    );
    renderDraft();
    await waitFor(() => expect(screen.getByDisplayValue('Ada')).toBeInTheDocument());
    // The worker lands a newer result after the form loaded.
    getDraft = () => ({
      ...BASE_DRAFT,
      version: 5,
      review_payload: {
        ...BASE_DRAFT.review_payload,
        work_history: [
          { employer_name: 'Initech', role_title: 'Analyst' },
          { employer_name: 'Globex', role_title: 'Engineer' },
        ],
      },
    });
    fireEvent.change(screen.getByLabelText('Professional title'), { target: { value: 'Lead' } });
    fireEvent.click(screen.getByRole('button', { name: /Create talent/ }));
    await waitFor(() => expect(promoted()).toBe(true));

    const ps = patches();
    expect(ps).toHaveLength(2);
    expect((ps[0]?.body as { expected_version: number }).expected_version).toBe(2);
    expect((ps[1]?.body as { expected_version: number }).expected_version).toBe(5);
    const retried = (ps[1]?.body as { review: Record<string, unknown> }).review;
    expect(retried['fields']).toMatchObject({ title: { value: 'Lead', origin: 'RECRUITER' } });
    expect('work_history' in retried).toBe(false);
    // Order: PATCH(409) → GET → PATCH → promote.
    const promoteIdx = calls.findIndex((c) => c.url.includes('/promote'));
    const lastPatchIdx = calls.lastIndexOf(ps[1] as Call);
    expect(lastPatchIdx).toBeLessThan(promoteIdx);
    await waitFor(() => expect(screen.getByDisplayValue('Globex')).toBeInTheDocument());
  });

  it('a save that fails stops the create — never promotes without the recruiter edits', async () => {
    patchResponses.push(() => jsonResponse({ error: { code: 'INTERNAL', message: 'x' } }, 500));
    renderDraft();
    await waitFor(() => expect(screen.getByDisplayValue('Ada')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Professional title'), { target: { value: 'Lead' } });
    fireEvent.click(screen.getByRole('button', { name: /Create talent/ }));
    await waitFor(() =>
      expect(screen.getByText(/latest changes couldn’t be saved/)).toBeInTheDocument(),
    );
    expect(promoted()).toBe(false);
  });

  it('ATI-SEP-1 D6: an edit refused because the Talent already exists (409 INTAKE_DRAFT_SAVED_EDIT_ON_TALENT) is not retried; the recruiter is directed to the Talent record', async () => {
    patchResponses.push(() =>
      jsonResponse(
        {
          error: {
            code: 'INTAKE_DRAFT_SAVED_EDIT_ON_TALENT',
            message: 'created',
            details: { reason: 'saved_edit_on_talent', talent_record_id: 't1' },
          },
        },
        409,
      ),
    );
    renderDraft();
    await waitFor(() => expect(screen.getByDisplayValue('Initech')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Role title 1'), { target: { value: 'Senior Analyst' } });
    await waitFor(() => expect(screen.getByText(/already been created/)).toBeInTheDocument(), {
      timeout: 3000,
    });
    const link = screen.getByRole('link', { name: /Open the Talent record/ });
    expect(link.getAttribute('href')).toBe('/talent/t1');
    // Not a stale version: no refetch-and-resend, and autosave stops.
    expect(patches()).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Role title 1'), { target: { value: 'Principal Analyst' } });
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches()).toHaveLength(1);
    // Create finishes the Save of the existing Talent and opens it.
    fireEvent.click(screen.getByRole('button', { name: /Create talent/ }));
    await waitFor(() => expect(promoted()).toBe(true));
    expect(patches()).toHaveLength(1);
  });

  it('a late extraction fills untouched fields and arrays while keeping the recruiter edit', async () => {
    getDraft = () => ({
      ...BASE_DRAFT,
      processing_status: 'PROCESSING',
      version: 1,
      review_payload: { fields: {} },
    });
    renderDraft();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Augusta' } });
    getDraft = () => BASE_DRAFT; // extraction completes (READY)
    await waitFor(() => expect(screen.getByDisplayValue('Initech')).toBeInTheDocument(), {
      timeout: 6000,
    });
    expect(screen.getByDisplayValue('Augusta')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Lovelace')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Ada')).toBeNull();
  }, 10_000);

  it('A1: City and State carry no required marker, there is no "/5 required" count, and create needs neither', async () => {
    const { container } = renderDraft();
    await waitFor(() => expect(screen.getByDisplayValue('Ada')).toBeInTheDocument());
    const requiredLabels = Array.from(container.querySelectorAll('.rc-secfield__req')).map(
      (el) => el.parentElement?.textContent?.replace('*', '').trim(),
    );
    expect(requiredLabels).toEqual(
      expect.arrayContaining(['First name', 'Last name', 'Primary email', 'Mobile']),
    );
    expect(requiredLabels).not.toContain('City');
    expect(requiredLabels).not.toContain('State');
    expect(screen.getByLabelText('City')).not.toBeRequired();
    expect(screen.getByLabelText('State')).not.toBeRequired();
    expect(container.textContent ?? '').not.toMatch(/\/5 required/);
    expect(screen.queryAllByText('City and state')).toHaveLength(0);
    // No city/state on this draft — Create is still available and promotes.
    const create = screen.getByRole('button', { name: /Create talent/ });
    expect(create).not.toBeDisabled();
    fireEvent.click(create);
    await waitFor(() => expect(promoted()).toBe(true));
  });
});
