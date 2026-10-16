import type { ScheduledMeetingView } from '../../microsoft/microsoft-api';
import type {
  ScreeningBasis,
  ScreeningQuestion,
  ScreeningSession,
  ScreeningSessionDetail,
} from '../../technical-screening/technical-screening-api';

// Talent × Requisition 360 → Technical Screening — pure presentation helpers.
// Host authority: ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED as extended by A1 Note 1
// (TR360 as a second host). Everything here is derived ONLY from what the INC-3/A1
// reads return; nothing infers attendance, completion, a level or a fit.

// ── Which session this tab shows ────────────────────────────────────────────
// The sessions for THIS requisition (voided ones excluded); the latest DRAFT wins,
// else the latest CONFIRMED. Sessions without a requisition never match.
export function pickSession(sessions: readonly ScreeningSession[], reqId: string): ScreeningSession | null {
  const mine = sessions
    .filter((s) => s.requisition_id === reqId && s.state !== 'VOIDED')
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return mine.find((s) => s.state === 'DRAFT') ?? mine.find((s) => s.state === 'CONFIRMED') ?? null;
}

// ── Phase: only what the backend can tell ───────────────────────────────────
// DRAFT without a meeting → Prepared; DRAFT with a meeting → Scheduled;
// CONFIRMED → Complete; VOIDED (reached only from history) → Voided. There is
// deliberately no live / in-progress / findings-due phase (A1 :337, :340).
export type Tr360ScreeningPhase = 'prepared' | 'scheduled' | 'complete' | 'voided';

export function screeningPhase(session: ScreeningSession): Tr360ScreeningPhase {
  if (session.state === 'CONFIRMED') return 'complete';
  if (session.state === 'VOIDED') return 'voided';
  return session.interaction_id !== null ? 'scheduled' : 'prepared';
}

export const PHASE_PILL: Record<Tr360ScreeningPhase, { label: string; tone: 'blue' | 'green' | 'grey' }> = {
  prepared: { label: 'Prepared', tone: 'blue' },
  scheduled: { label: 'Scheduled', tone: 'blue' },
  complete: { label: 'Complete', tone: 'green' },
  voided: { label: 'Voided', tone: 'grey' },
};

export const SESSION_STATE_PILL: Record<ScreeningSession['state'], { label: string; tone: 'blue' | 'green' | 'grey' }> = {
  DRAFT: { label: 'Draft', tone: 'blue' },
  CONFIRMED: { label: 'Complete', tone: 'green' },
  VOIDED: { label: 'Voided', tone: 'grey' },
};

// ── Questions ───────────────────────────────────────────────────────────────
export const QUESTION_STATUS_LABEL: Record<ScreeningQuestion['status'], string> = {
  SELECTED: 'Selected',
  PROPOSED: 'Proposed',
  REMOVED: 'Removed',
};

// A1 :154 — AI-drafted text is labelled exactly this.
export const AI_DRAFTED_LABEL = 'AI-drafted — review required';

export function planQuestions(detail: ScreeningSessionDetail): ScreeningQuestion[] {
  return detail.questions.filter((q) => q.status !== 'REMOVED').sort((a, b) => a.position - b.position);
}

export function questionTitle(q: ScreeningQuestion): string {
  const ref = q.skill_ref?.trim() ?? '';
  if (ref !== '') return ref;
  return q.origin === 'AI_GENERATED' ? 'Question' : 'Your question';
}

export function questionMeta(q: ScreeningQuestion): string {
  return `${QUESTION_STATUS_LABEL[q.status]} · ${q.origin === 'AI_GENERATED' ? 'AI-drafted' : 'Added by you'}`;
}

// The plan's provenance: one line from the latest QUESTION_PLAN generation's
// used_requisition / used_talent_profile (questions carry no per-question source).
export function planProvenance(detail: ScreeningSessionDetail, reqCode: string, talentFirstName: string): string {
  const plan = [...detail.generations].reverse().find((g) => g.kind === 'QUESTION_PLAN');
  if (plan === undefined) return 'Questions added by you';
  const from = [plan.used_requisition ? reqCode : null, plan.used_talent_profile ? `${talentFirstName}’s resume` : null].filter(
    (x): x is string => x !== null,
  );
  return `Drafted by Aramo${from.length > 0 ? ` from ${from.join(' and ')}` : ''} · reviewed by you`;
}

// ── Coverage: of the QUESTION PLAN, never of the talent ─────────────────────
// Must-have skills (the requisition profile's critical + required groups) vs the
// planned questions' free-text skill_ref, case-insensitive, contained either way.
export interface PlanCoverageRow {
  readonly skill: string;
  readonly count: number;
}

const norm = (s: string): string => s.trim().toLowerCase();

export function planCoverage(mustHaves: readonly string[], questions: readonly ScreeningQuestion[]): PlanCoverageRow[] {
  const refs = questions
    .filter((q) => q.status !== 'REMOVED')
    .map((q) => norm(q.skill_ref ?? ''))
    .filter((r) => r !== '');
  return mustHaves.map((skill) => {
    const k = norm(skill);
    return { skill, count: k === '' ? 0 : refs.filter((r) => r.includes(k) || k.includes(r)).length };
  });
}

// ── Findings: the closed basis set, in TR360 copy (INC-3 :275, DDR :47) ──────
export const TR360_BASIS_LABEL: Record<ScreeningBasis, string> = {
  SELF_REPORTED: 'Self-reported',
  RECRUITER_OBSERVED: 'Recruiter-observed',
  DEMONSTRATED: 'Demonstrated (observed by the recruiter, not independently verified)',
};

// ── Scheduled banner from the calendar-meeting read ─────────────────────────
export function formatMeetingDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatMeetingTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function scheduledTitle(meeting: ScheduledMeetingView | null): string {
  if (meeting !== null && meeting.status === 'cancelled') return 'Teams meeting cancelled';
  if (meeting === null || meeting.scheduled_start === null) return 'Scheduled · Teams';
  const start = meeting.scheduled_start;
  const minutes =
    meeting.scheduled_end !== null
      ? Math.round((new Date(meeting.scheduled_end).getTime() - new Date(start).getTime()) / 60_000)
      : null;
  return `Scheduled · ${formatMeetingDate(start)} at ${formatMeetingTime(start)} · Teams${
    minutes !== null && minutes > 0 ? ` · ${minutes} min` : ''
  }`;
}

// ── Honest AI errors (fail closed) ──────────────────────────────────────────
interface ApiErrorLike {
  readonly status?: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}

export function aiErrorKind(e: unknown): 'no_llm_key' | 'consent' | 'ai_unavailable' | null {
  if (typeof e !== 'object' || e === null) return null;
  const err = e as ApiErrorLike;
  if (err.code === 'LLM_PROVIDER_NOT_CONFIGURED') return 'no_llm_key';
  if (err.code === 'SCREENING_AI_UNAVAILABLE') return 'ai_unavailable';
  const reason = err.details?.['reason'];
  if (err.code === 'INSUFFICIENT_PERMISSIONS' && reason === 'ai_processing_not_authorized') return 'consent';
  return null;
}

export function aiErrorMessage(kind: NonNullable<ReturnType<typeof aiErrorKind>>, talentFirstName: string): string {
  switch (kind) {
    case 'no_llm_key':
      return 'Aramo can’t draft with AI: no AI provider key is configured for your organization. An administrator can add one. You can still add your own questions.';
    case 'consent':
      return `${talentFirstName} hasn’t authorized AI processing, so nothing about ${talentFirstName} was sent to the AI. You can draft from the requisition only, or add your own questions.`;
    case 'ai_unavailable':
      return 'AI drafting is temporarily unavailable. Try again shortly.';
  }
}
