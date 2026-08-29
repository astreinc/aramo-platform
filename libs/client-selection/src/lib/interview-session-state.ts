// Lane 2 / L2-F (F2) — the InterviewSession state machine. One scheduling under a
// ClientSelectionProcess: SCHEDULED → {RESCHEDULED | COMPLETED | CANCELED | NO_SHOW};
// RESCHEDULED self-loops (re-reschedule, new scheduled_at); COMPLETED/CANCELED/NO_SHOW
// terminal.

export const INTERVIEW_SESSION_STATE_VALUES = [
  'SCHEDULED',
  'RESCHEDULED',
  'COMPLETED',
  'CANCELED',
  'NO_SHOW',
] as const;
export type InterviewSessionState =
  (typeof INTERVIEW_SESSION_STATE_VALUES)[number];

export function isInterviewSessionState(
  v: unknown,
): v is InterviewSessionState {
  return (
    typeof v === 'string' &&
    (INTERVIEW_SESSION_STATE_VALUES as readonly string[]).includes(v)
  );
}

// The initial state every session is scheduled at.
export const INTERVIEW_SESSION_INITIAL_STATE: InterviewSessionState = 'SCHEDULED';

// Terminal states — no outgoing transitions.
export const INTERVIEW_SESSION_TERMINAL_STATES: readonly InterviewSessionState[] =
  ['COMPLETED', 'CANCELED', 'NO_SHOW'];

// LEGAL_TRANSITIONS — the legal `to` states per `from`.
//   SCHEDULED: reschedule (new scheduled_at) or conclude (completed / canceled / no_show).
//   RESCHEDULED: re-reschedule (self-loop) or conclude — same options as SCHEDULED.
//   COMPLETED / CANCELED / NO_SHOW: terminal.
const LEGAL_TRANSITIONS: Record<
  InterviewSessionState,
  readonly InterviewSessionState[]
> = {
  SCHEDULED: ['RESCHEDULED', 'COMPLETED', 'CANCELED', 'NO_SHOW'],
  RESCHEDULED: ['RESCHEDULED', 'COMPLETED', 'CANCELED', 'NO_SHOW'],
  COMPLETED: [],
  CANCELED: [],
  NO_SHOW: [],
};

export function isTerminalInterviewSessionState(
  state: InterviewSessionState,
): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}

/**
 * canTransitionInterviewSession — the legal-transition guard. Note SCHEDULED→SCHEDULED
 * and the terminal self-edges are NOT legal (only RESCHEDULED self-loops); the
 * repository intercepts a genuine no-op (from === to) before opening the tx only for
 * RESCHEDULED, so callers cannot no-op a terminal.
 */
export function canTransitionInterviewSession(
  from: InterviewSessionState,
  to: InterviewSessionState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalNextInterviewSessionStates(
  from: InterviewSessionState,
): readonly InterviewSessionState[] {
  return LEGAL_TRANSITIONS[from];
}
