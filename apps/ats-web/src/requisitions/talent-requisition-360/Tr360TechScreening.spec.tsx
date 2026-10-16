import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as ms from '../../microsoft/microsoft-api';
import * as api from '../../technical-screening/technical-screening-api';
import type {
  ScreeningFinding,
  ScreeningQuestion,
  ScreeningSession,
  ScreeningSessionDetail,
} from '../../technical-screening/technical-screening-api';

import { Tr360TechScreening } from './Tr360TechScreening';
import { pickSession, planCoverage } from './tr360-screening-model';

// TR360 → Technical Screening, flag ON (A1 Note 1: TR360 as a second host of the
// INC-3/A1 flow). The screening + Microsoft clients are mocked; every lifecycle
// rule is server-side. These prove the tab loads only this requisition's session,
// maps only the states the backend can tell, uses the governed replacements
// (Selected/Proposed, AI-drafted label, basis instead of levels), computes
// question-plan coverage, and fails closed without screening:read.

vi.mock('../../technical-screening/technical-screening-api');
vi.mock('../../microsoft/microsoft-api');

const NOW = '2026-10-15T10:00:00Z';
const ALL = [
  'screening:read', 'screening:create', 'screening:edit', 'screening:confirm',
  'communication:meeting:create', 'communication:meeting:read',
];
const LEVEL_WORDS = /\b(Strong|Moderate|Limited|Not demonstrated)\b/;

function sess(over: Partial<ScreeningSession> = {}): ScreeningSession {
  return {
    id: 's1', talent_record_id: 'tal-1', interaction_id: null, requisition_id: 'req-1', state: 'DRAFT', version: 3,
    created_at: NOW, updated_at: NOW, created_by_actor_id: 'u1', confirmed_by_actor_id: null, confirmed_at: null,
    confirmed_version: null, voided_by_actor_id: null, voided_at: null, void_reason: null, ...over,
  };
}
function question(over: Partial<ScreeningQuestion> = {}): ScreeningQuestion {
  return {
    id: 'q1', text: 'Describe a time you used SQL to validate a report.', skill_ref: 'SQL', intent: 'PROBE',
    origin: 'AI_GENERATED', status: 'SELECTED', edited: false, position: 1, generation_id: 'g1', ...over,
  };
}
const FINDING: ScreeningFinding = {
  id: 'f1', skill_raw: 'SQL', basis: 'DEMONSTRATED', observation_raw: 'Wrote a join to reconcile totals.',
  demonstration_raw: 'Shared screen and ran the query.', limitations_raw: null, origin: 'RECRUITER_AUTHORED',
  review_status: null, evidence_source: 'RECRUITER_OBSERVATION', ai_original: null, reviewed_by_actor_id: null,
  reviewed_at: null, created_at: NOW, updated_at: NOW,
};
function detail(over: Partial<ScreeningSessionDetail> = {}): ScreeningSessionDetail {
  return {
    session: sess(), findings: [], publications: [], citations: [],
    questions: [
      question(),
      question({ id: 'q2', text: 'How do you map a process?', skill_ref: 'Process mapping', status: 'PROPOSED', position: 2 }),
      question({ id: 'q3', text: 'My own question', skill_ref: null, origin: 'RECRUITER_AUTHORED', position: 3, generation_id: null }),
    ],
    notes: [], suggestions: [],
    generations: [
      { id: 'g1', kind: 'QUESTION_PLAN', provider: 'anthropic', model: 'm', used_talent_profile: true, used_requisition: true, used_transcript: false, created_at: NOW },
    ],
    transcripts: [], analyses: [], ...over,
  };
}

function renderTab(scopes: readonly string[] = ALL, enabled = true): void {
  render(
    <MemoryRouter>
      <Tr360TechScreening
        enabled={enabled}
        talentId="tal-1"
        reqId="req-1"
        scopes={scopes}
        talentFirstName="Ravi"
        reqCode="REQ-1001"
        mustHaveSkills={['Requirements elicitation', 'SQL']}
      />
    </MemoryRouter>,
  );
}

function apiError(status: number, code: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error('x'), { status, code, details });
}

describe('Tr360TechScreening (flag on)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(ms.getCalendarMeeting).mockRejectedValue(new Error('not mocked'));
    vi.mocked(api.getScreeningCaptureModes).mockResolvedValue({
      recruiter_notes: { status: 'available' }, teams_post_meeting: { status: 'available' },
      live_external_provider: { status: 'no_approved_provider' }, meeting: { status: 'scheduled' },
      recording: { status: 'requested' }, transcript: { status: 'none', count: 0 },
    });
  });

  it('without screening:read: the access message and no screening call', async () => {
    renderTab(['requisition:read']);
    expect(screen.getByText('You don’t have access to technical screening.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New screening' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Screening history' })).toBeNull();
    await Promise.resolve();
    expect(api.listScreeningSessions).not.toHaveBeenCalled();
    expect(api.getScreeningSession).not.toHaveBeenCalled();
  });

  it('flag off: the empty state only, no calls', () => {
    renderTab(ALL, false);
    expect(screen.getByText('No technical screening yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare screening' })).toBeNull();
    expect(api.listScreeningSessions).not.toHaveBeenCalled();
  });

  it('not started → Prepare screening creates a session for this requisition, then drafts the plan', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess({ requisition_id: 'req-9' })] });
    vi.mocked(api.createScreeningSession).mockResolvedValue(sess({ id: 's-new' }));
    vi.mocked(api.generateScreeningQuestions).mockResolvedValue(detail({ session: sess({ id: 's-new' }) }));
    renderTab();
    expect(await screen.findByText('No technical screening yet')).toBeInTheDocument();
    expect(screen.queryByText(/requires a technical screening/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'View guidelines' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare screening' }));
    await waitFor(() => expect(api.generateScreeningQuestions).toHaveBeenCalledWith('s-new', true));
    expect(api.createScreeningSession).toHaveBeenCalledWith('tal-1', 'req-1');
    expect(await screen.findByText('Screening prepared · 3 questions')).toBeInTheDocument();
  });

  it('prepare without ai_processing consent: an honest message, then a requisition-only draft', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [] });
    vi.mocked(api.createScreeningSession).mockResolvedValue(sess({ id: 's-new' }));
    vi.mocked(api.generateScreeningQuestions)
      .mockRejectedValueOnce(apiError(403, 'INSUFFICIENT_PERMISSIONS', { reason: 'ai_processing_not_authorized' }))
      .mockResolvedValueOnce(detail({ session: sess({ id: 's-new' }) }));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare screening' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ravi hasn’t authorized AI processing');
    fireEvent.click(screen.getByRole('button', { name: 'Draft from the requisition only' }));
    await waitFor(() => expect(api.generateScreeningQuestions).toHaveBeenLastCalledWith('s-new', false));
  });

  it('prepare without a tenant LLM key: fails closed with an honest message', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [] });
    vi.mocked(api.createScreeningSession).mockResolvedValue(sess({ id: 's-new' }));
    vi.mocked(api.generateScreeningQuestions).mockRejectedValue(apiError(422, 'LLM_PROVIDER_NOT_CONFIGURED'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare screening' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no AI provider key is configured');
    expect(screen.queryByRole('button', { name: 'Draft from the requisition only' })).toBeNull();
    expect(screen.getByText('Screening prepared · no questions yet')).toBeInTheDocument();
  });

  it('prepared: questions with Selected/Proposed, the AI-drafted label, provenance banner and computed coverage', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detail());
    renderTab();
    expect(await screen.findByText('Screening prepared · 3 questions')).toBeInTheDocument();
    expect(screen.getByText('Drafted by Aramo from REQ-1001 and Ravi’s resume · reviewed by you')).toBeInTheDocument();
    expect(screen.getByText('Prepared')).toBeInTheDocument();
    expect(screen.getByText('Selected · AI-drafted')).toBeInTheDocument();
    expect(screen.getByText('Proposed · AI-drafted')).toBeInTheDocument();
    expect(screen.getByText('Selected · Added by you')).toBeInTheDocument();
    expect(screen.getByText('AI-drafted — review required')).toBeInTheDocument();
    expect(screen.queryByText(/Must-ask|Optional/)).toBeNull();
    const cov = screen.getByTestId('tr360-screening-coverage');
    expect(within(cov).getByText('Question-plan coverage of must-have skills')).toBeInTheDocument();
    expect(within(cov).getByText('1 question')).toBeInTheDocument();
    expect(within(cov).getByText('none')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule on Teams' })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(LEVEL_WORDS);
    expect(document.body.textContent ?? '').not.toMatch(/Retained|In progress|End call|Supporting evidence/);
    expect(screen.queryByRole('button', { name: '+ Add' })).toBeNull(); // no evidence attachments
  });

  it('prepared: select toggle, edit, remove and add-your-own (with skill) call the question routes', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detail());
    vi.mocked(api.updateScreeningQuestion).mockResolvedValue(detail());
    vi.mocked(api.addScreeningQuestion).mockResolvedValue(detail());
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Selected' }));
    await waitFor(() => expect(api.updateScreeningQuestion).toHaveBeenCalledWith('s1', 'q1', { status: 'PROPOSED' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Question text' }), { target: { value: 'Edited text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.updateScreeningQuestion).toHaveBeenCalledWith('s1', 'q1', { text: 'Edited text' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.updateScreeningQuestion).toHaveBeenCalledWith('s1', 'q1', { status: 'REMOVED' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your question' }), { target: { value: 'Walk me through Yardi.' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill it covers' }), { target: { value: 'Yardi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.addScreeningQuestion).toHaveBeenCalledWith('s1', 'Walk me through Yardi.', 'Yardi'));
  });

  it('follow-ups "from your plan and notes": suggest from a note; Ask next marks USED and adds the question', async () => {
    const withNote = detail({
      notes: [{ id: 'n1', body: 'Wrote a query to compare totals.', created_at: NOW }],
      suggestions: [],
    });
    const withSuggestion = detail({
      notes: withNote.notes,
      suggestions: [{ id: 'sg1', generation_id: 'g2', text: 'Which joins did that need?', trigger_kind: 'NOTE', trigger_ref: { note_id: 'n1' }, action: null, created_at: NOW }],
    });
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(withNote);
    vi.mocked(api.requestScreeningSuggestions).mockResolvedValue(withSuggestion);
    vi.mocked(api.actionScreeningSuggestion).mockResolvedValue(withNote);
    vi.mocked(api.addScreeningQuestion).mockResolvedValue(withNote);
    renderTab();
    expect(await screen.findByText('Suggestions from your plan and notes. Advisory only — never findings.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Suggest follow-ups' }));
    await waitFor(() => expect(api.requestScreeningSuggestions).toHaveBeenCalledWith('s1', 'n1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask next' }));
    await waitFor(() => expect(api.addScreeningQuestion).toHaveBeenCalledWith('s1', 'Which joins did that need?'));
    expect(api.actionScreeningSuggestion).toHaveBeenCalledWith('s1', 'sg1', 'USED');
  });

  it('scheduled: time from the calendar-meeting read and a Join Teams call link to join_url', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess({ interaction_id: 'int-1' })] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detail({ session: sess({ interaction_id: 'int-1' }) }));
    vi.mocked(ms.getCalendarMeeting).mockResolvedValue({
      interaction_id: 'int-1', operation_id: null, provider_event_id: null, join_url: 'https://teams.example/join/1',
      status: 'scheduled', version: 1, scheduled_start: '2026-10-16T14:30:00Z', scheduled_end: '2026-10-16T15:15:00Z',
      idempotent_replay: false,
    });
    renderTab();
    expect(await screen.findByText(/^Scheduled · Oct 16, 2026 at .* · Teams · 45 min$/)).toBeInTheDocument();
    expect(ms.getCalendarMeeting).toHaveBeenCalledWith('int-1');
    expect(screen.getByRole('link', { name: 'Join Teams call' })).toHaveAttribute('href', 'https://teams.example/join/1');
    expect(await screen.findByText('Recording requested')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Schedule on Teams' })).toBeNull();
    expect(screen.queryByText(/consent asked on the call/)).toBeNull();
  });

  it('prepared → Schedule on Teams posts the slot (no recording checkbox, no retention line)', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detail());
    vi.mocked(api.scheduleScreeningMeeting).mockResolvedValue({
      meeting: { interaction_id: 'int-1', join_url: 'https://teams.example/j', idempotent_replay: false, artifact_preparation: 'x', record_automatically: false },
      session: detail({ session: sess({ interaction_id: 'int-1' }) }),
    });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule on Teams' }));
    expect(screen.getByText('Schedule technical screening')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Retained/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule & send invitation' }));
    await waitFor(() => expect(api.scheduleScreeningMeeting).toHaveBeenCalled());
    const slot = vi.mocked(api.scheduleScreeningMeeting).mock.calls[0]?.[1];
    expect(slot?.subject).toBe('Technical screening · REQ-1001');
    expect(new Date(slot?.end_date_time ?? '').getTime() - new Date(slot?.start_date_time ?? '').getTime()).toBe(45 * 60_000);
    expect(await screen.findByRole('link', { name: 'Join Teams call' })).toHaveAttribute('href', 'https://teams.example/j');
  });

  it('final outcome: findings with the basis set, then confirm with attestation sends the confirmed set + version', async () => {
    const d = detail({ findings: [FINDING] });
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(d);
    vi.mocked(api.confirmScreeningSession).mockResolvedValue(detail({ session: sess({ state: 'CONFIRMED' }), findings: [FINDING] }));
    renderTab();
    const outcome = await screen.findByTestId('tr360-screening-outcome');
    expect(within(outcome).getByText('Demonstrated (observed by the recruiter, not independently verified)')).toBeInTheDocument();
    fireEvent.click(within(outcome).getByRole('button', { name: 'Complete screening' }));
    const confirm = screen.getByRole('button', { name: 'Confirm findings' });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(api.confirmScreeningSession).toHaveBeenCalledWith('s1', 3, ['f1']));
    expect(await screen.findByText('Screening complete')).toBeInTheDocument();
  });

  it('final outcome: Add finding offers the three basis labels; no level scale anywhere', async () => {
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [sess()] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detail());
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: '+ Add finding' }));
    const basis = screen.getByRole('combobox', { name: 'Basis' });
    expect(within(basis).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Self-reported',
      'Recruiter-observed',
      'Demonstrated (observed by the recruiter, not independently verified)',
    ]);
    expect(screen.getByRole('button', { name: 'Complete screening' })).toBeDisabled();
    expect(document.body.textContent ?? '').not.toMatch(LEVEL_WORDS);
  });

  it('complete: findings with publication status and retry; no overall level or reviewer', async () => {
    const confirmed = sess({ state: 'CONFIRMED', confirmed_at: '2026-10-16T12:00:00Z', confirmed_by_actor_id: 'u1' });
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items: [confirmed] });
    vi.mocked(api.getScreeningSession).mockResolvedValue(
      detail({
        session: confirmed,
        findings: [FINDING, { ...FINDING, id: 'f2', skill_raw: 'Process mapping', basis: 'SELF_REPORTED', demonstration_raw: null }],
        publications: [
          { id: 'p1', finding_id: 'f1', evidence_record_id: 'e1', state: 'PUBLISHED', attempt_count: 1, last_attempt_at: NOW, last_error_code: null, published_at: NOW, created_at: NOW, trust_status: 'VALID' },
          { id: 'p2', finding_id: 'f2', evidence_record_id: 'e2', state: 'PENDING', attempt_count: 1, last_attempt_at: new Date().toISOString(), last_error_code: null, published_at: null, created_at: NOW, trust_status: null },
        ],
      }),
    );
    vi.mocked(api.retryScreeningPublication).mockResolvedValue(detail({ session: confirmed }));
    renderTab();
    expect(await screen.findByText('Screening complete')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText(/2 findings recorded as recruiter-attested evidence/)).toBeInTheDocument();
    expect(screen.getAllByTestId('tr360-screening-finding')).toHaveLength(2);
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Publishing…')).toBeInTheDocument();
    expect(screen.getByText('Self-reported')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete screening' })).toBeNull();
    expect(screen.queryByText(/recorded by|overall/i)).toBeNull();
    expect(document.body.textContent ?? '').not.toMatch(LEVEL_WORDS);
    fireEvent.click(screen.getByRole('button', { name: 'Retry publishing' }));
    await waitFor(() => expect(api.retryScreeningPublication).toHaveBeenCalledWith('s1'));
  });

  it('loads only this requisition’s session: latest DRAFT over CONFIRMED; voided and other requisitions ignored', async () => {
    const items = [
      sess({ id: 'old-confirmed', state: 'CONFIRMED', created_at: '2026-10-01T00:00:00Z' }),
      sess({ id: 'draft', state: 'DRAFT', created_at: '2026-10-02T00:00:00Z' }),
      sess({ id: 'voided', state: 'VOIDED', created_at: '2026-10-09T00:00:00Z' }),
      sess({ id: 'other-req', requisition_id: 'req-9', created_at: '2026-10-10T00:00:00Z' }),
      sess({ id: 'no-req', requisition_id: null, created_at: '2026-10-11T00:00:00Z' }),
    ];
    expect(pickSession(items, 'req-1')?.id).toBe('draft');
    expect(pickSession(items.filter((s) => s.id !== 'draft'), 'req-1')?.id).toBe('old-confirmed');
    expect(pickSession(items.filter((s) => s.requisition_id !== 'req-1' || s.state === 'VOIDED'), 'req-1')).toBeNull();
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items });
    vi.mocked(api.getScreeningSession).mockResolvedValue(detail({ session: sess({ id: 'draft' }) }));
    renderTab();
    await screen.findByText('Screening prepared · 3 questions');
    expect(api.getScreeningSession).toHaveBeenCalledTimes(1);
    expect(api.getScreeningSession).toHaveBeenCalledWith('draft');
    expect(screen.getByRole('button', { name: '+ New screening' })).toBeDisabled();
  });

  it('Screening history: this requisition’s sessions, plus sessions without a requisition shown separately', async () => {
    const items = [
      sess({ id: 'draft', created_at: '2026-10-02T00:00:00Z' }),
      sess({ id: 'old', state: 'CONFIRMED', created_at: '2026-10-01T00:00:00Z', confirmed_at: '2026-10-01T05:00:00Z' }),
      sess({ id: 'other-req', requisition_id: 'req-9' }),
      sess({ id: 'no-req', requisition_id: null }),
    ];
    vi.mocked(api.listScreeningSessions).mockResolvedValue({ items });
    vi.mocked(api.getScreeningSession).mockImplementation(async (id) => detail({ session: items.find((s) => s.id === id) ?? sess() }));
    renderTab();
    await screen.findByText('Screening prepared · 3 questions');
    fireEvent.click(screen.getByRole('button', { name: 'Screening history' }));
    const history = screen.getByTestId('tr360-screening-history');
    expect(within(history).getAllByTestId('tr360-screening-history-row')).toHaveLength(3);
    expect(within(history).getByText('On REQ-1001')).toBeInTheDocument();
    expect(within(history).getByText('Without a requisition')).toBeInTheDocument();
    expect(within(history).getByRole('link', { name: 'Open in workspace ↗' })).toHaveAttribute('href', '/talent/tal-1/screening');
    expect(within(history).getByText('Showing')).toBeInTheDocument();
    fireEvent.click(within(history).getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Screening complete')).toBeInTheDocument();
    expect(api.getScreeningSession).toHaveBeenLastCalledWith('old');
  });
});

describe('planCoverage (question plan, never the talent)', () => {
  it('counts non-removed questions whose skill_ref matches a must-have, case-insensitive, either way', () => {
    const qs = [
      question({ skill_ref: 'sql' }),
      question({ id: 'b', skill_ref: 'Advanced SQL queries' }),
      question({ id: 'c', skill_ref: 'SQL', status: 'REMOVED' }),
      question({ id: 'd', skill_ref: null }),
    ];
    expect(planCoverage(['SQL', 'Yardi'], qs)).toEqual([
      { skill: 'SQL', count: 2 },
      { skill: 'Yardi', count: 0 },
    ]);
  });
});
