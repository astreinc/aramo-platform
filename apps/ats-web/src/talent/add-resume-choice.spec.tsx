import { renderHook, waitFor } from '@testing-library/react';
import { ApiError } from '@aramo/fe-foundation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  orderResumeChoices,
  resumeSelectionErrorMessage,
  suggestedResumeId,
  useCanSetResume,
} from './add-resume-choice';
import type { TalentResumeEditionView } from './types';

// ATS-QA-1 I-5 — the shared résumé-choice helpers used by both add dialogs.
const h = vi.hoisted(() => ({ fetchSession: vi.fn() }));
vi.mock('@aramo/fe-foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aramo/fe-foundation')>()),
  fetchSession: h.fetchSession,
}));

const edition = (
  id: string,
  over: Partial<TalentResumeEditionView> = {},
): TalentResumeEditionView => ({
  edition_id: id,
  talent_document_id: `d-${id}`,
  attachment_id: null,
  purpose: 'GENERAL',
  label: null,
  lifecycle_status: 'active',
  created_at: '2026-10-01T00:00:00.000Z',
  filename: `${id}.pdf`,
  mime_type: 'application/pdf',
  uploaded_at: '2026-10-01T00:00:00.000Z',
  is_default: false,
  revision_number: null,
  requisition_id: null,
  client_context_id: null,
  derived_from_edition_id: null,
  processing_status: null,
  ...over,
});

beforeEach(() => h.fetchSession.mockReset());

describe('orderResumeChoices / suggestedResumeId', () => {
  it('offers only active editions: tailored for this requisition, then the default, then newest first', () => {
    const out = orderResumeChoices(
      [
        edition('old', { created_at: '2026-09-01T00:00:00.000Z' }),
        edition('new', { created_at: '2026-10-05T00:00:00.000Z' }),
        edition('def', { is_default: true, created_at: '2026-08-01T00:00:00.000Z' }),
        edition('tailored', { requisition_id: 'r1', created_at: '2026-07-01T00:00:00.000Z' }),
        edition('other-req', { requisition_id: 'r2', created_at: '2026-10-09T00:00:00.000Z' }),
        edition('archived', { lifecycle_status: 'archived' }),
        edition('retracted', { lifecycle_status: 'retracted' }),
      ],
      'r1',
    );
    expect(out.map((e) => e.edition_id)).toEqual(['tailored', 'def', 'other-req', 'new', 'old']);
    expect(suggestedResumeId(out)).toBe('def'); // the suggested default, not the first row
  });

  it('with no default the first offered edition is preselected; none offered → null', () => {
    expect(suggestedResumeId(orderResumeChoices([edition('a'), edition('b')], null))).toBe('a');
    expect(suggestedResumeId([])).toBeNull();
  });
});

describe('resumeSelectionErrorMessage', () => {
  it('maps each refusal of the selection write to its own plain reason', () => {
    expect(resumeSelectionErrorMessage(new ApiError(403, 'x', 'INSUFFICIENT_PERMISSIONS'))).toMatch(
      /permission/,
    );
    expect(resumeSelectionErrorMessage(new ApiError(404, 'x', 'NOT_FOUND'))).toBe(
      'That resume is no longer available for this talent.',
    );
    expect(resumeSelectionErrorMessage(new ApiError(422, 'x', 'VALIDATION_ERROR'))).toBe(
      'That resume has been archived or withdrawn.',
    );
    expect(resumeSelectionErrorMessage(new Error('boom'))).toBe(
      'The resume choice couldn’t be saved.',
    );
  });
});

describe('useCanSetResume', () => {
  it('uses the host prop without reading the session', () => {
    const { result } = renderHook(() => useCanSetResume(true, true));
    expect(result.current).toBe(true);
    expect(h.fetchSession).not.toHaveBeenCalled();
  });

  it('reads pipeline:resume:set from the session on first open (null while reading)', async () => {
    h.fetchSession.mockResolvedValue({ sub: 'u', scopes: ['pipeline:add', 'pipeline:resume:set'] });
    const { result } = renderHook(() => useCanSetResume(true, undefined));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('a session without the scope, or a failed read, is false', async () => {
    h.fetchSession.mockResolvedValueOnce({ sub: 'u', scopes: ['pipeline:add'] });
    const a = renderHook(() => useCanSetResume(true, undefined));
    await waitFor(() => expect(a.result.current).toBe(false));
    h.fetchSession.mockRejectedValueOnce(new Error('offline'));
    const b = renderHook(() => useCanSetResume(true, undefined));
    await waitFor(() => expect(b.result.current).toBe(false));
  });

  it('does not read the session while the dialog is closed', () => {
    renderHook(() => useCanSetResume(false, undefined));
    expect(h.fetchSession).not.toHaveBeenCalled();
  });
});
