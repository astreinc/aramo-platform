// Canonical "interview today" semantic — the ONE derivation of whether an
// interview session counts as happening today on the recruiter's surfaces.
//
// Owned here because the fact is an InterviewSession: it is "today" iff the
// session is in a LIVE (non-terminal) state AND its scheduled_at civil date
// equals the request-instant civil date, BOTH resolved in the app timezone (the
// shared @aramo/common primitive) — never the UTC calendar day and never a
// rolling 24-hour window (the §38 boundary trap).
//
// Consumers (My Desk "interviews today", Talent 360 attention) read this result;
// they do NOT re-decide today-ness nor re-list the live states.

import { isoDateInTimeZone } from '@aramo/common';

import {
  INTERVIEW_SESSION_STATE_VALUES,
  INTERVIEW_SESSION_TERMINAL_STATES,
  type InterviewSessionState,
} from './interview-session-state.js';

// The LIVE (schedulable-and-pending) interview states — derived from the
// lifecycle's terminal set so it cannot drift from the state machine. Today this
// is { SCHEDULED, RESCHEDULED }; a concluded (COMPLETED/CANCELED/NO_SHOW) session
// is never "today".
export const LIVE_INTERVIEW_STATES: readonly InterviewSessionState[] =
  INTERVIEW_SESSION_STATE_VALUES.filter(
    (s) => !INTERVIEW_SESSION_TERMINAL_STATES.includes(s),
  );

const LIVE_SET: ReadonlySet<string> = new Set<string>(LIVE_INTERVIEW_STATES);

export function isLiveInterviewState(
  state: InterviewSessionState | string | null | undefined,
): boolean {
  return typeof state === 'string' && LIVE_SET.has(state);
}

export function isInterviewToday(args: {
  readonly state: InterviewSessionState | string | null | undefined;
  readonly scheduled_at_ms: number | null;
  readonly now_ms: number;
  readonly time_zone: string;
}): boolean {
  if (args.scheduled_at_ms === null || Number.isNaN(args.scheduled_at_ms)) return false;
  if (!isLiveInterviewState(args.state)) return false;
  return (
    isoDateInTimeZone(args.scheduled_at_ms, args.time_zone) ===
    isoDateInTimeZone(args.now_ms, args.time_zone)
  );
}
