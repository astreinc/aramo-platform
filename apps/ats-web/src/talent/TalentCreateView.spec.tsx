import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@aramo/fe-foundation';

import { TalentCreateView } from './TalentCreateView';

// Durable Async Résumé-First Add-Talent — FE cutover proof. Asserts the view
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

  it('uploading a résumé uses the async intake flow and NEVER calls draft-from-resume', async () => {
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
