// libs/selection (@aramo/selection) — canonical Selection domain barrel
// (T2-P2). Exposes the domain surface consumed by the libs/engagement
// controller-only facade and by the relocated production consumers
// (record-reconcile orchestrator, evidence, outbox-publisher, seed-e2e).
//
// The HTTP wire DTOs (Create/Transition/List/Outreach/Record request +
// response) remain in the libs/engagement facade and are NOT re-exported
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

// Delivery port (moved from the engagement domain; consumed by the
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
