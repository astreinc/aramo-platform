// CI-B6 — processing-run state machine. Explicit transitions; terminal states
// are immutable (also DB-trigger enforced). `completed` is the successful
// terminal (READY_FOR_REVIEW for B7).

import type { ConversationIntelligenceRunStatus } from './run-enums.js';
import { CiRunInvalidStateError } from './errors.js';

export const CI_RUN_TRANSITIONS: Readonly<
  Record<ConversationIntelligenceRunStatus, readonly ConversationIntelligenceRunStatus[]>
> = {
  queued: ['processing', 'blocked_not_authorized', 'failed_terminal', 'intervention_required'],
  processing: [
    'completed',
    'failed_retryable',
    'intervention_required',
    'failed_terminal',
    'blocked_not_authorized',
  ],
  failed_retryable: ['processing', 'intervention_required', 'failed_terminal'],
  intervention_required: ['processing', 'failed_terminal'],
  // Re-drivable: consent may later allow ai_processing → re-attempt.
  blocked_not_authorized: ['processing', 'failed_terminal'],
  // Terminal (immutable) — no outgoing transitions.
  completed: [],
  failed_terminal: [],
} as const;

export function canCiRunTransition(
  from: ConversationIntelligenceRunStatus,
  to: ConversationIntelligenceRunStatus,
): boolean {
  return CI_RUN_TRANSITIONS[from].includes(to);
}

export function assertCiRunTransition(
  from: ConversationIntelligenceRunStatus,
  to: ConversationIntelligenceRunStatus,
): void {
  if (!canCiRunTransition(from, to)) {
    throw new CiRunInvalidStateError(from, to);
  }
}
