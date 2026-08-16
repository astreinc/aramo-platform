// libs/selection (@aramo/selection) — canonical Selection domain barrel
// (T2-P2). Exposes the domain surface consumed by the libs/selection
// controller-only facade and by the relocated production consumers
// (record-reconcile orchestrator, evidence, outbox-publisher, seed-e2e).
//
// The HTTP wire DTOs (Create/Transition/List/Outreach/Record request +
// response) remain in the libs/selection facade and are NOT re-exported
// here — only domain symbols cross this boundary.

export { SelectionModule } from './lib/selection.module.js';
export { SelectionRepository } from './lib/selection.repository.js';
export { SelectionEventRepository } from './lib/selection-event.repository.js';
export { SelectionOutboxRepository } from './lib/selection-outbox.repository.js';
export type { UnpublishedOutboxEvent as SelectionUnpublishedOutboxEvent } from './lib/selection-outbox.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type { TalentSelectionView } from './lib/dto/talent-selection.view.js';
export type { TalentSelectionEventView } from './lib/dto/talent-selection-event.view.js';
export type { AppendEventInput } from './lib/selection-event.repository.js';

// Delivery port (moved from the selection domain; consumed by the
// facade controller's outreach/send path).
export type {
  DeliveryProvider,
  DeliveryInput,
  DeliveryResult,
} from './lib/delivery/delivery-provider.interface.js';
export { DELIVERY_PROVIDER_TOKEN } from './lib/delivery/tokens.js';
export { SendStubDeliveryProvider } from './lib/delivery/send-stub.provider.js';

// Typed event payloads (consumed by the facade controller + repository).
export type { OutreachSentPayload } from './lib/dto/outreach-sent-payload.js';
export type { OutreachDraftedPayload } from './lib/dto/outreach-drafted-payload.js';
export type { SelectionResponseReceivedPayload } from './lib/dto/selection-response-received-payload.js';
export type { SelectionConversationStartedPayload } from './lib/dto/selection-conversation-started-payload.js';

// State-machine + event-type closed lists (runtime const tuples + types).
export {
  SELECTION_STATE_VALUES,
  canTransition,
} from './lib/selection-state.js';
export type { SelectionStateValue } from './lib/selection-state.js';

export { SELECTION_EVENT_TYPE_VALUES } from './lib/selection-event.js';
export type { SelectionEventTypeValue } from './lib/selection-event.js';

// T2-P3B — the HTTP controller surface, folded in from the retired
// libs/selection facade. The /v1/selections controller + wire
// request/response DTOs (the selection:* wire contract) now live here.
export { SelectionController } from './lib/selection.controller.js';
export { CreateSelectionRequestDto } from './lib/dto/create-selection-request.dto.js';
export type { CreateSelectionResponseDto } from './lib/dto/create-selection-response.dto.js';
export { TransitionSelectionRequestDto } from './lib/dto/transition-selection-request.dto.js';
export type { TransitionSelectionResponseDto } from './lib/dto/transition-selection-response.dto.js';
export type { SelectionListResponseDto } from './lib/dto/selection-list-response.dto.js';
export type { SelectionListEventsResponseDto } from './lib/dto/selection-list-events-response.dto.js';
export { OutreachDraftRequestDto } from './lib/dto/outreach-draft-request.dto.js';
export type {
  OutreachDraftResponseDto,
  OutreachDraftConsentWarning,
} from './lib/dto/outreach-draft-response.dto.js';
export { OutreachSendRequestDto } from './lib/dto/outreach-send-request.dto.js';
export type { OutreachSendResponseDto } from './lib/dto/outreach-send-response.dto.js';
export { RecordResponseRequestDto } from './lib/dto/record-response-request.dto.js';
export type { RecordResponseResponseDto } from './lib/dto/record-response-response.dto.js';
export { RecordConversationStartedRequestDto } from './lib/dto/record-conversation-started-request.dto.js';
export type { RecordConversationStartedResponseDto } from './lib/dto/record-conversation-started-response.dto.js';
