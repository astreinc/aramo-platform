export { EngagementModule } from './lib/engagement.module.js';
export { EngagementController } from './lib/engagement.controller.js';
export { EngagementRepository } from './lib/engagement.repository.js';
export { EngagementEventRepository } from './lib/engagement-event.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type { TalentJobEngagementView } from './lib/dto/talent-job-engagement.view.js';
export type { TalentEngagementEventView } from './lib/dto/talent-engagement-event.view.js';
export type { AppendEventInput } from './lib/engagement-event.repository.js';

// M5 PR-4 — HTTP-layer DTOs.
export { CreateEngagementRequestDto } from './lib/dto/create-engagement-request.dto.js';
export type { CreateEngagementResponseDto } from './lib/dto/create-engagement-response.dto.js';
export { TransitionEngagementRequestDto } from './lib/dto/transition-engagement-request.dto.js';
export type { TransitionEngagementResponseDto } from './lib/dto/transition-engagement-response.dto.js';
export type { EngagementListEventsResponseDto } from './lib/dto/engagement-list-events-response.dto.js';

// M5 PR-6 — outreach HTTP DTOs + delivery port.
export { OutreachSendRequestDto } from './lib/dto/outreach-send-request.dto.js';
export type { OutreachSendResponseDto } from './lib/dto/outreach-send-response.dto.js';
export type { OutreachSentPayload } from './lib/dto/outreach-sent-payload.js';
export type {
  DeliveryProvider,
  DeliveryInput,
  DeliveryResult,
} from './lib/delivery/delivery-provider.interface.js';
export { DELIVERY_PROVIDER_TOKEN } from './lib/delivery/tokens.js';
export { SendStubDeliveryProvider } from './lib/delivery/send-stub.provider.js';

// M5 PR-7 — response-received HTTP DTOs + typed event payload.
export { RecordResponseRequestDto } from './lib/dto/record-response-request.dto.js';
export type { RecordResponseResponseDto } from './lib/dto/record-response-response.dto.js';
export type { EngagementResponseReceivedPayload } from './lib/dto/engagement-response-received-payload.js';

// M5 PR-8a — conversation-started HTTP DTOs + typed event payload.
export { RecordConversationStartedRequestDto } from './lib/dto/record-conversation-started-request.dto.js';
export type { RecordConversationStartedResponseDto } from './lib/dto/record-conversation-started-response.dto.js';
export type { EngagementConversationStartedPayload } from './lib/dto/engagement-conversation-started-payload.js';

export {
  ENGAGEMENT_STATE_VALUES,
  canTransition,
} from './lib/engagement-state.js';
export type { EngagementStateValue } from './lib/engagement-state.js';

export { ENGAGEMENT_EVENT_TYPE_VALUES } from './lib/engagement-event.js';
export type { EngagementEventTypeValue } from './lib/engagement-event.js';
