export { ClientSelectionModule } from './lib/client-selection.module.js';
export { ClientSelectionController } from './lib/client-selection.controller.js';
export { ClientSelectionProcessRepository } from './lib/client-selection.repository.js';
export { PrismaService as ClientSelectionPrismaService } from './lib/prisma/prisma.service.js';
// Lane 2 / L2-F (F1) — the 7th outbox drain namespace, consumed by libs/outbox-publisher.
export { ClientSelectionOutboxRepository } from './lib/client-selection-outbox.repository.js';
export type { UnpublishedOutboxEvent as ClientSelectionUnpublishedOutboxEvent } from './lib/client-selection-outbox.repository.js';
export { ClientSelectionOutboxModule } from './lib/client-selection-outbox.module.js';

export {
  CLIENT_SELECTION_STATE_VALUES,
  CLIENT_SELECTION_INITIAL_STATE,
  CLIENT_SELECTION_TERMINAL_STATES,
  isClientSelectionState,
  isTerminalClientSelectionState,
  canTransitionClientSelection,
  legalNextClientSelectionStates,
  type ClientSelectionState,
} from './lib/client-selection-state.js';

// L3-E(2) — closed disposition classification (TERMINATES vs PRESERVES) for the governed
// DECLINE/WITHDRAW → Pipeline disposition orchestration (apps/api).
export {
  WITHDRAW_REASON_EFFECT,
  isWithdrawReasonCode,
  isDispositionOutcomeState,
  considerationEffect,
  type ConsiderationEffect,
  type WithdrawReasonCode,
  type DispositionOutcomeState,
} from './lib/disposition-classification.js';

export type { ClientSelectionProcessView } from './lib/dto/client-selection-process.view.js';
export type {
  TransitionClientSelectionRequestDto,
  CreateClientSelectionRequestDto,
} from './lib/dto/client-selection-request.dto.js';

// Lane 2 / L2-F (F2) — the InterviewSession child aggregate.
export { InterviewSessionRepository } from './lib/interview-session.repository.js';
export {
  INTERVIEW_SESSION_STATE_VALUES,
  INTERVIEW_SESSION_INITIAL_STATE,
  INTERVIEW_SESSION_TERMINAL_STATES,
  isInterviewSessionState,
  isTerminalInterviewSessionState,
  canTransitionInterviewSession,
  legalNextInterviewSessionStates,
  type InterviewSessionState,
} from './lib/interview-session-state.js';
export type { InterviewSessionView } from './lib/dto/interview-session.view.js';
export type {
  ScheduleInterviewRequestDto,
  TransitionInterviewSessionRequestDto,
} from './lib/dto/interview-session-request.dto.js';

// Lane 2 / L2-F (F3) — the owner-sourced journey-stage projection (consumed by L2-H).
export { JourneyProjectionRepository } from './lib/journey-projection.repository.js';
export type {
  JourneyStageView,
  JourneyStageKind,
} from './lib/dto/journey-stage.view.js';
