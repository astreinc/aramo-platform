// libs/engagement — controller-only frozen facade barrel (T2-P2).
//
// Post-split, this lib exposes ONLY the frozen /v1/engagements HTTP
// surface: the EngagementModule (route wiring) + EngagementController +
// the wire request/response DTOs. The Selection domain (repositories,
// PrismaService, delivery port, views, typed payloads, state/event
// closed-lists) is canonical in @aramo/selection and is NOT re-exported
// here — consumers import it from @aramo/selection directly.

export { EngagementModule } from './lib/engagement.module.js';
export { EngagementController } from './lib/engagement.controller.js';

// M5 PR-4 — HTTP-layer DTOs (the frozen engagement:* wire contract).
export { CreateEngagementRequestDto } from './lib/dto/create-engagement-request.dto.js';
export type { CreateEngagementResponseDto } from './lib/dto/create-engagement-response.dto.js';
export { TransitionEngagementRequestDto } from './lib/dto/transition-engagement-request.dto.js';
export type { TransitionEngagementResponseDto } from './lib/dto/transition-engagement-response.dto.js';
export type { EngagementListEventsResponseDto } from './lib/dto/engagement-list-events-response.dto.js';

// M5 PR-6 — outreach draft/send HTTP DTOs (the delivery port itself now
// lives in @aramo/selection).
export { OutreachDraftRequestDto } from './lib/dto/outreach-draft-request.dto.js';
export type {
  OutreachDraftResponseDto,
  OutreachDraftConsentWarning,
} from './lib/dto/outreach-draft-response.dto.js';
export { OutreachSendRequestDto } from './lib/dto/outreach-send-request.dto.js';
export type { OutreachSendResponseDto } from './lib/dto/outreach-send-response.dto.js';

// M5 PR-7 — response-received HTTP DTOs.
export { RecordResponseRequestDto } from './lib/dto/record-response-request.dto.js';
export type { RecordResponseResponseDto } from './lib/dto/record-response-response.dto.js';

// M5 PR-8a — conversation-started HTTP DTOs.
export { RecordConversationStartedRequestDto } from './lib/dto/record-conversation-started-request.dto.js';
export type { RecordConversationStartedResponseDto } from './lib/dto/record-conversation-started-response.dto.js';
