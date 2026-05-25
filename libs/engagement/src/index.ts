export { EngagementModule } from './lib/engagement.module.js';
export { EngagementRepository } from './lib/engagement.repository.js';
export { EngagementEventRepository } from './lib/engagement-event.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type { TalentJobEngagementView } from './lib/dto/talent-job-engagement.view.js';
export type { TalentEngagementEventView } from './lib/dto/talent-engagement-event.view.js';
export type { AppendEventInput } from './lib/engagement-event.repository.js';

export {
  ENGAGEMENT_STATE_VALUES,
  canTransition,
} from './lib/engagement-state.js';
export type { EngagementStateValue } from './lib/engagement-state.js';

export { ENGAGEMENT_EVENT_TYPE_VALUES } from './lib/engagement-event.js';
export type { EngagementEventTypeValue } from './lib/engagement-event.js';
