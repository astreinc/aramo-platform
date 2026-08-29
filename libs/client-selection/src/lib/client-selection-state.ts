// Lane 2 / L2-F (F1) — the ClientSelectionProcess state machine. The client's
// review-and-decision lifecycle over one submitted talent. This is the OWNER of the
// interview-consideration + client-decline truths Pipeline faked (Lane2-DDR §2 D-3).

export const CLIENT_SELECTION_STATE_VALUES = [
  'CLIENT_REVIEW',
  'INTERVIEW',
  'SELECTED',
  'DECLINED',
  'WITHDRAWN',
] as const;
export type ClientSelectionState =
  (typeof CLIENT_SELECTION_STATE_VALUES)[number];

export function isClientSelectionState(v: unknown): v is ClientSelectionState {
  return (
    typeof v === 'string' &&
    (CLIENT_SELECTION_STATE_VALUES as readonly string[]).includes(v)
  );
}

// The initial state every process is created at.
export const CLIENT_SELECTION_INITIAL_STATE: ClientSelectionState = 'CLIENT_REVIEW';

// Terminal states — no outgoing transitions.
export const CLIENT_SELECTION_TERMINAL_STATES: readonly ClientSelectionState[] = [
  'SELECTED',
  'DECLINED',
  'WITHDRAWN',
];

// LEGAL_TRANSITIONS — the legal `to` states per `from`.
//   CLIENT_REVIEW: begin an interview round, or decide directly (select/decline) or
//     withdraw the submitted talent from client consideration.
//   INTERVIEW: after interviewing, decide (select/decline) or withdraw. A return to
//     CLIENT_REVIEW is intentionally NOT modelled at F1 (interview rounds are F2's
//     InterviewSession concern; the process stays at INTERVIEW across rounds).
//   SELECTED / DECLINED / WITHDRAWN: terminal.
const LEGAL_TRANSITIONS: Record<
  ClientSelectionState,
  readonly ClientSelectionState[]
> = {
  CLIENT_REVIEW: ['INTERVIEW', 'SELECTED', 'DECLINED', 'WITHDRAWN'],
  INTERVIEW: ['SELECTED', 'DECLINED', 'WITHDRAWN'],
  SELECTED: [],
  DECLINED: [],
  WITHDRAWN: [],
};

export function isTerminalClientSelectionState(
  state: ClientSelectionState,
): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}

/**
 * canTransitionClientSelection — the legal-transition guard. No-op (from === to) is
 * treated as legal here; the repository intercepts it before opening the tx.
 */
export function canTransitionClientSelection(
  from: ClientSelectionState,
  to: ClientSelectionState,
): boolean {
  if (from === to) return true;
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function legalNextClientSelectionStates(
  from: ClientSelectionState,
): readonly ClientSelectionState[] {
  return LEGAL_TRANSITIONS[from];
}
