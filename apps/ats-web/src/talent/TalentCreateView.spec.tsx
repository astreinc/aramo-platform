import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@aramo/fe-foundation';

import { TalentCreateView } from './TalentCreateView';

// Durable Async Resume-First Add-Talent — FE cutover proof. Asserts the view
// drives the async intake flow (create-intake → S3 → complete-upload) and NEVER
// the retired synchronous POST /v1/talent-records/draft-from-resume; that ?draft=
// fully restores a persisted draft from backend state; and that an already-
// promoted draft resolves to the created Talent rather than re-creating.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const READY_DRAFT = {
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
      city: { value: 'London', origin: 'RESUME_EXTRACTION' },
      state: { value: 'NA', origin: 'RESUME_EXTRACTION' },
    },
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

describe('TalentCreateView — durable async intake cutover', () => {
  let calls: { url: string; method: string }[];
  let getDraft: () => unknown;

  beforeEach(() => {
    calls = [];
    getDraft = () => READY_DRAFT;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.includes('/me')) return Promise.resolve(jsonResponse({}, 404));
      if (url.includes('duplicate-check')) return Promise.resolve(jsonResponse({ match: null }));
      if (url.startsWith('https://s3/')) return Promise.resolve(new Response(null, { status: 200 }));
      if (url.includes('/complete-upload')) {
        return Promise.resolve(jsonResponse({ draft_id: 'd1', processing_status: 'QUEUED' }, 202));
      }
      if (url.includes('/promote')) {
        return Promise.resolve(
          jsonResponse({ id: 't1', first_name: 'Ada', last_name: 'Lovelace' }, 201),
        );
      }
      if (url.endsWith('/v1/talent-intake-drafts') && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              draft_id: 'd1',
              upload_url: 'https://s3/put',
              storage_key: 'k/d1',
              processing_status: 'UPLOADED',
              expires_at: 'z',
            },
            201,
          ),
        );
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

  it('uploading a resume uses the async intake flow and NEVER calls draft-from-resume', async () => {
    render(
      <MemoryRouter>
        <ToastProvider>
          <TalentCreateView />
        </ToastProvider>
      </MemoryRouter>,
    );
    const input = screen.getByTestId('resume-file-input');
    const file = new File(['resume bytes'], 'ada.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/complete-upload'))).toBe(true),
    );

    // The async intake endpoints are used, in order.
    expect(
      calls.some((c) => c.url.endsWith('/v1/talent-intake-drafts') && c.method === 'POST'),
    ).toBe(true);
    expect(calls.some((c) => c.url.startsWith('https://s3/'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/complete-upload') && c.method === 'POST')).toBe(true);

    // The retired synchronous surface is NEVER touched.
    expect(calls.some((c) => c.url.includes('/draft-from-resume'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/resume-upload-url'))).toBe(false);
  });

  it('?draft= fully restores the persisted draft from backend state', async () => {
    render(
      <MemoryRouter initialEntries={['/talent/new?draft=d1']}>
        <ToastProvider>
          <TalentCreateView />
        </ToastProvider>
      </MemoryRouter>,
    );
    // The form is hydrated from GET /v1/talent-intake-drafts/d1 — no re-upload.
    await waitFor(() => expect(screen.getByDisplayValue('Ada')).toBeInTheDocument());
    expect(
      calls.some((c) => c.url.includes('/v1/talent-intake-drafts/d1') && c.method === 'GET'),
    ).toBe(true);
    expect(calls.some((c) => c.url.includes('/draft-from-resume'))).toBe(false);
  });

  it('an already-promoted draft resolves to the created Talent (no re-create)', async () => {
    getDraft = () => ({
      ...READY_DRAFT,
      review_status: 'PROMOTED',
      promoted_talent_record_id: 't1',
    });
    render(
      <MemoryRouter initialEntries={['/talent/new?draft=d1']}>
        <ToastProvider>
          <TalentCreateView />
        </ToastProvider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/v1/talent-intake-drafts/d1'))).toBe(true),
    );
    // No promote call is attempted for an already-promoted draft.
    expect(calls.some((c) => c.url.includes('/promote'))).toBe(false);
  });
});

// ATI-SEP-1 A5 — Add Talent as designed: the recruiter can always create (manual
// entry, no resume), and every intake state is stated truthfully (specific
// failure copy, PARTIAL ≠ READY, a stalled upload offers retry/replace), with
// autosave running while the resume is still being read. PDF/DOCX only.
describe('TalentCreateView — ATI-SEP-1 A5 Add Talent UX', () => {
  interface Call {
    url: string;
    method: string;
    body: unknown;
  }
  let calls: Call[];
  let getDraft: () => unknown;
  let completeUploadStatus: number;

  const MANUAL_DRAFT = {
    ...READY_DRAFT,
    id: 'm1',
    source_filename: null,
    mime_type: null,
    size_bytes: null,
    review_status: 'NOT_STARTED',
    review_payload: null,
    version: 1,
  };

  beforeEach(() => {
    calls = [];
    getDraft = () => READY_DRAFT;
    completeUploadStatus = 202;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.includes('/me')) return Promise.resolve(jsonResponse({}, 404));
      if (url.includes('duplicate-check')) return Promise.resolve(jsonResponse({ match: null }));
      if (url.startsWith('https://s3/')) return Promise.resolve(new Response(null, { status: 200 }));
      if (url.endsWith('/v1/talent-intake-drafts/manual') && method === 'POST') {
        return Promise.resolve(jsonResponse(MANUAL_DRAFT, 201));
      }
      if (url.includes('/complete-upload')) {
        return Promise.resolve(
          completeUploadStatus === 202
            ? jsonResponse({ draft_id: 'd1', processing_status: 'QUEUED' }, 202)
            : jsonResponse({ code: 'INTERNAL_ERROR', message: 'boom' }, completeUploadStatus),
        );
      }
      if (url.includes('/retry')) {
        return Promise.resolve(jsonResponse({ ...READY_DRAFT, processing_status: 'QUEUED' }));
      }
      if (url.includes('/promote')) {
        return Promise.resolve(
          jsonResponse({ id: 't9', first_name: 'Grace', last_name: 'Hopper' }, 201),
        );
      }
      if (url.endsWith('/v1/talent-intake-drafts') && method === 'POST') {
        return Promise.resolve(
          jsonResponse(
            {
              draft_id: 'd1',
              upload_url: 'https://s3/put',
              storage_key: 'k/d1',
              processing_status: 'UPLOADED',
              expires_at: 'z',
            },
            201,
          ),
        );
      }
      if (url.endsWith('/v1/talent-intake-drafts') && method === 'GET') {
        return Promise.resolve(jsonResponse({ items: [] }));
      }
      if (/\/v1\/talent-intake-drafts\/(d1|m1)$/.test(url) && method === 'PATCH') {
        const expected = (body as { expected_version: number }).expected_version;
        const base = url.endsWith('/m1') ? MANUAL_DRAFT : (getDraft() as typeof READY_DRAFT);
        return Promise.resolve(jsonResponse({ ...base, version: expected + 1 }));
      }
      if (url.endsWith('/v1/talent-intake-drafts/m1') && method === 'GET') {
        return Promise.resolve(jsonResponse(MANUAL_DRAFT));
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

  function renderView(entry = '/talent/new') {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <ToastProvider>
          <TalentCreateView />
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('Enter details manually creates a manual draft (no upload) and promotes it through the same route', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Enter details manually' }));
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());
    expect(screen.getByText(/No resume attached/)).toBeInTheDocument();
    expect(screen.queryByText(/Resume read/)).toBeNull();
    // Nothing about a resume is gating: no "Resume attached" requirement row.
    expect(screen.queryAllByText('Resume attached')).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Grace' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Hopper' } });
    fireEvent.change(screen.getByLabelText('Primary email'), {
      target: { value: 'grace@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Mobile'), { target: { value: '+15550001111' } });
    const create = screen.getByRole('button', { name: /Create talent/ });
    await waitFor(() => expect(create).not.toBeDisabled());
    fireEvent.click(create);
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/m1/promote') && c.method === 'POST')).toBe(true),
    );
    expect(
      calls.some((c) => c.url.endsWith('/v1/talent-intake-drafts/manual') && c.method === 'POST'),
    ).toBe(true);
    // Manual entry never touches the upload path.
    expect(calls.some((c) => c.url.startsWith('https://s3/'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/complete-upload'))).toBe(false);
    expect(
      calls.some((c) => c.url.endsWith('/v1/talent-intake-drafts') && c.method === 'POST'),
    ).toBe(false);
  });

  it.each([
    [
      'provider_truncated',
      'This resume was too long to read in one pass. Enter the details below — the resume stays attached.',
    ],
    [
      'RESUME_UNREADABLE',
      'We couldn’t read any text in this file (it may be a scanned image or protected). Enter the details below, or replace it with a PDF or DOCX that contains text.',
    ],
  ])('FAILED (%s) renders the specific backend failure copy', async (_code, copy) => {
    getDraft = () => ({ ...READY_DRAFT, processing_status: 'FAILED', failure: copy });
    renderView('/talent/new?draft=d1');
    await waitFor(() => expect(screen.getByText(copy)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Try reading again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace resume' })).toBeInTheDocument();
    // Addendum A2 (A-b): a failed read never blocks — the form stays editable and
    // Create is enabled once name + email1 + phone are valid.
    expect(screen.getByLabelText('First name')).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Augusta' } });
    expect(screen.getByRole('button', { name: /Create talent/ })).not.toBeDisabled();
  });

  it('FAILED with no failure prose falls back to a generic, still-actionable message', async () => {
    getDraft = () => ({ ...READY_DRAFT, processing_status: 'FAILED', failure: null });
    renderView('/talent/new?draft=d1');
    await waitFor(() =>
      expect(
        screen.getByText(/Enter the details below — the resume stays attached\./),
      ).toBeInTheDocument(),
    );
  });

  it('PARTIAL says "Partially read", never the READY "Resume read" copy', async () => {
    getDraft = () => ({ ...READY_DRAFT, processing_status: 'PARTIAL' });
    renderView('/talent/new?draft=d1');
    await waitFor(() =>
      expect(screen.getByText(/Partially read — some fields may be missing/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Resume read/)).toBeNull();
  });

  it('READY still says "Resume read"', async () => {
    renderView('/talent/new?draft=d1');
    await waitFor(() => expect(screen.getByText(/Resume read/)).toBeInTheDocument());
    expect(screen.queryByText(/Partially read/)).toBeNull();
  });

  it('accepts only PDF and DOCX (no legacy .doc / application/msword)', async () => {
    renderView();
    const accept = screen.getByTestId('resume-file-input').getAttribute('accept') ?? '';
    expect(accept.split(',')).not.toContain('.doc');
    expect(accept).not.toMatch(/msword/);
    expect(accept).toMatch(/\.pdf/);
    expect(accept).toMatch(/\.docx/);
  });

  it('a failed complete-upload shows the stalled state with Try again → POST /retry', async () => {
    completeUploadStatus = 500;
    getDraft = () => ({ ...READY_DRAFT, processing_status: 'UPLOADED' });
    renderView();
    const file = new File(['resume bytes'], 'ada.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByTestId('resume-file-input'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByText(/The resume upload didn’t finish/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Reading resume/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Replace resume' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/d1/retry') && c.method === 'POST')).toBe(true),
    );
  });

  it('autosaves recruiter edits while the resume is still PROCESSING', async () => {
    getDraft = () => ({
      ...READY_DRAFT,
      processing_status: 'PROCESSING',
      review_payload: { fields: {} },
    });
    renderView('/talent/new?draft=d1');
    await waitFor(() => expect(screen.getByText(/Reading resume/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Augusta' } });
    await waitFor(
      () => expect(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/d1'))).toBe(true),
      { timeout: 3000 },
    );
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(
      (patch?.body as { review: { fields: Record<string, { value: string; origin: string }> } })
        .review.fields['first_name'],
    ).toEqual({ value: 'Augusta', origin: 'RECRUITER' });
  });
});
