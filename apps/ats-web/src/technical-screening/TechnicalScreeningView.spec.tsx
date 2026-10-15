import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TechnicalScreeningView, TRUST_STATUS_LABEL, publicationLabel } from './TechnicalScreeningView';
import * as api from './technical-screening-api';
import type { ScreeningPublication, ScreeningSessionDetail } from './technical-screening-api';

// TIP-E2E INC-3 (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §5/§11, as amended by
// ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED A1-7) — presentation tests for the
// Technical Screening workspace. The API is mocked; every lifecycle rule is
// server-side — this proves the FE renders state honestly, gates controls by
// scope, sends the exact confirmed set + version, reloads on 409, labels AI
// output as drafts, blocks confirmation until AI drafts are reviewed, and never
// presents an unavailable capture mode as live.

vi.mock('./technical-screening-api');
const h = vi.hoisted(() => ({ scopes: [] as string[] }));
vi.mock('@aramo/fe-foundation', async (importActual) => {
  const actual = await importActual<typeof import('@aramo/fe-foundation')>();
  return {
    ...actual,
    useSession: () => ({
      status: 'authenticated' as const,
      session: { sub: 'u1', consumer_type: 'recruiter' as const, tenant_id: 't1', scopes: h.scopes, iat: 0, exp: 9_999_999_999 },
    }),
    hasScope: (s: { scopes?: string[] } | null, scope: string) => s?.scopes?.includes(scope) ?? false,
  };
});

const ALL = ['screening:read', 'screening:create', 'screening:edit', 'screening:confirm'];
const NOW = new Date('2026-10-15T10:00:00Z').toISOString();

function session(over: Partial<ScreeningSessionDetail['session']> = {}): ScreeningSessionDetail['session'] {
  return {
    id: 's1', talent_record_id: 't-1', interaction_id: null, requisition_id: null, state: 'DRAFT', version: 2,
    created_at: NOW, updated_at: NOW, created_by_actor_id: 'u1', confirmed_by_actor_id: null,
    confirmed_at: null, confirmed_version: null, voided_by_actor_id: null, voided_at: null, void_reason: null,
    ...over,
  };
}
const finding: api.ScreeningFinding = {
  id: 'f1', skill_raw: 'Kubernetes', basis: 'DEMONSTRATED' as const,
  observation_raw: 'Explained disruption budgets.', demonstration_raw: 'Drained a node live.',
  limitations_raw: null, origin: 'RECRUITER_AUTHORED', review_status: null, evidence_source: 'RECRUITER_OBSERVATION',
  ai_original: null, reviewed_by_actor_id: null, reviewed_at: null, created_at: NOW, updated_at: NOW,
};
const aiFinding: api.ScreeningFinding = {
  ...finding, id: 'f2', skill_raw: 'Go', basis: 'SELF_REPORTED', observation_raw: 'Said they wrote Go services.',
  demonstration_raw: null, origin: 'AI_DRAFTED', review_status: 'DRAFT', evidence_source: 'MEETING_TRANSCRIPT',
  ai_original: { observation_raw: 'Said they wrote Go services.' },
};
function detailOf(over: Partial<ScreeningSessionDetail> = {}): ScreeningSessionDetail {
  return {
    session: session(), findings: [finding], publications: [], citations: [], questions: [], notes: [],
    suggestions: [], generations: [], transcripts: [], analyses: [], ...over,
  };
}
function pub(over: Partial<ScreeningPublication> = {}): ScreeningPublication {
  return {
    id: 'p1', finding_id: 'f1', evidence_record_id: 'e1', state: 'PUBLISHED', attempt_count: 1,
    last_attempt_at: NOW, last_error_code: null, published_at: NOW, created_at: NOW, trust_status: 'VALID', ...over,
  };
}

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/talent/t-1/screening']}>
      <Routes>
        <Route path="/talent/:talentId/screening" element={<TechnicalScreeningView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TechnicalScreeningView', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.scopes = [...ALL];
    vi.mocked(api.getScreeningCaptureModes).mockResolvedValue({
      recruiter_notes: { status: 'available' },
      teams_post_meeting: { status: 'not_connected' },
      live_external_provider: { status: 'no_approved_provider' },
    });
  });

  it('shows the honest empty state and gates "Start screening" on screening:create', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [] });
    h.scopes = ['screening:read'];
    renderAt();
    expect(await screen.findByText('No technical screenings yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start screening' })).toBeNull();
    // Honest copy: AI output is the recruiter's to accept, never verification.
    expect(screen.getByText(/yours to accept, edit or reject/)).toBeTruthy();
    expect(screen.getByText(/not independent/)).toBeTruthy();
  });

  it('a DRAFT shows findings with recruiter-honest basis copy and edit controls', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf());
    renderAt();
    expect(await screen.findByText('Kubernetes')).toBeTruthy();
    expect(screen.getAllByText('Observed by the recruiter (not independently verified)').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Add finding' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review and confirm' })).toBeTruthy();
  });

  it('confirm requires the attestation and sends the exact finding set + version', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf());
    vi.mocked(api.confirmScreeningSession).mockResolvedValue(
      detailOf({ session: session({ state: 'CONFIRMED', version: 3 }), publications: [pub()] }),
    );
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Review and confirm' }));
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm findings' });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(api.confirmScreeningSession).toHaveBeenCalledWith('s1', 2, ['f1']));
    expect(await screen.findByText('Published')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add finding' })).toBeNull();
  });

  it('a 409 reloads the session and says so', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf());
    vi.mocked(api.removeScreeningFinding).mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/changed since you opened it/)).toBeTruthy();
    expect(vi.mocked(api.getScreeningSession).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a CONFIRMED session is read-only; a PENDING intent offers retry to a confirm holder', async () => {
    const confirmed = session({ state: 'CONFIRMED', version: 3 });
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [confirmed] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(
      detailOf({ session: confirmed, publications: [pub({ state: 'PENDING', trust_status: null, published_at: null })] }),
    );
    renderAt();
    expect(await screen.findByRole('button', { name: 'Retry publishing' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
  });

  it('trust-status labels are honest — "corrected" is never shown (directive §5)', () => {
    expect(Object.values(TRUST_STATUS_LABEL).some((l) => /corrected/i.test(l) && !/not corrected/i.test(l))).toBe(false);
    expect(publicationLabel(pub({ trust_status: 'REVOKED' })).text).toBe('Withdrawn after dispute — not corrected');
    expect(publicationLabel(pub({ trust_status: 'DISPUTED' })).text).toBe('Contested — under review');
    expect(publicationLabel(pub({ state: 'CONFLICT', trust_status: null })).text).toMatch(/operator action/);
    const old = new Date(Date.parse(NOW) - 11 * 60 * 1000).toISOString();
    expect(publicationLabel(pub({ state: 'PENDING', last_attempt_at: old, trust_status: null }), Date.parse(NOW)).text).toMatch(/delayed/);
  });

  // ---- INC-3 A1-7 ----------------------------------------------------------

  it('AI drafts are labelled, block confirmation until reviewed, and Accept records CONFIRMED at the session version', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf({ findings: [finding, aiFinding] }));
    vi.mocked(api.reviewScreeningFinding).mockResolvedValue(
      detailOf({ session: session({ version: 3 }), findings: [finding, { ...aiFinding, review_status: 'CONFIRMED' }] }),
    );
    renderAt();
    expect(await screen.findByText('AI-drafted · from the meeting transcript · awaiting your review')).toBeTruthy();
    expect(screen.getByText(/1 AI-drafted finding\(s\) await your review/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review and confirm' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Accept as drafted' }));
    await waitFor(() => expect(api.reviewScreeningFinding).toHaveBeenCalledWith('s1', 'f2', 2, 'CONFIRMED'));
    expect(await screen.findByText('AI-drafted · from the meeting transcript · accepted by you')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review and confirm' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a rejected AI draft is excluded from the confirmed set', async () => {
    const rejected = { ...aiFinding, review_status: 'REJECTED' as const };
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf({ findings: [finding, rejected] }));
    vi.mocked(api.confirmScreeningSession).mockResolvedValue(detailOf({ session: session({ state: 'CONFIRMED', version: 3 }) }));
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Review and confirm' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /accurately record/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm findings' }));
    await waitFor(() => expect(api.confirmScreeningSession).toHaveBeenCalledWith('s1', 2, ['f1']));
  });

  it('question plan: generate (profile opt-out honoured), then select an AI question', async () => {
    const q: api.ScreeningQuestion = {
      id: 'q1', text: 'How do you roll back a failed deploy?', skill_ref: 'Kubernetes', intent: 'PROBE',
      origin: 'AI_GENERATED', status: 'PROPOSED', edited: false, position: 0, generation_id: 'g1',
    };
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf());
    vi.mocked(api.generateScreeningQuestions).mockResolvedValue(detailOf({ questions: [q] }));
    vi.mocked(api.updateScreeningQuestion).mockResolvedValue(detailOf({ questions: [{ ...q, status: 'SELECTED' }] }));
    renderAt();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Include the talent profile/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate questions' }));
    await waitFor(() => expect(api.generateScreeningQuestions).toHaveBeenCalledWith('s1', false));
    expect(await screen.findByText('AI-generated')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    await waitFor(() => expect(api.updateScreeningQuestion).toHaveBeenCalledWith('s1', 'q1', { status: 'SELECTED' }));
    // The selected question becomes the interview checklist.
    expect(await screen.findByRole('list', { name: 'Question checklist' })).toBeTruthy();
  });

  it('capture modes are honest: Teams unavailable when not connected, live suggestions never offered', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf());
    renderAt();
    expect(await screen.findByText('Unavailable — Microsoft 365 not connected')).toBeTruthy();
    expect(screen.getByText('Not available — no approved live capture provider')).toBeTruthy();
  });

  it('scheduling needs communication:meeting:create; transcript retrieval and excerpts need screening:transcript:read', async () => {
    const linked = session({ interaction_id: 'int-1' });
    const cited: api.ScreeningCitation = { id: 'c1', finding_id: 'f2', conversation_transcript_id: 'ct-1', utterance_id: 'u1', start_offset: 0, end_offset: 5 };
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [linked] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf({ session: linked, findings: [aiFinding], citations: [cited] }));
    renderAt();
    expect(await screen.findByText(/A Teams meeting is linked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check for the Teams transcript' })).toBeNull();
    expect(screen.getByText('Transcript citation (you do not have transcript access)')).toBeTruthy();
  });

  it('with transcript access: the excerpt is fetched on demand and the schedule form appears for an unlinked session', async () => {
    h.scopes = [...ALL, 'communication:meeting:create', 'screening:transcript:read'];
    const cited: api.ScreeningCitation = { id: 'c1', finding_id: 'f2', conversation_transcript_id: 'ct-1', utterance_id: 'u1', start_offset: 0, end_offset: 5 };
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [session()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detailOf({ findings: [aiFinding], citations: [cited] }));
    vi.mocked(api.getScreeningCitationExcerpt).mockResolvedValue({
      citation_id: 'c1', conversation_transcript_id: 'ct-1', utterance_id: 'u1', speaker_role: 'UNKNOWN', excerpt: 'I wrote Go', utterance_text: 'I wrote Go services',
    });
    renderAt();
    expect(await screen.findByRole('form', { name: 'Schedule meeting' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View cited transcript excerpt' }));
    expect(await screen.findByText('“I wrote Go”')).toBeTruthy();
    expect(api.getScreeningCitationExcerpt).toHaveBeenCalledWith('s1', 'c1');
  });
});
