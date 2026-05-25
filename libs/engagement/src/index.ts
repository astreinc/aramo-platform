export { EngagementModule } from './lib/engagement.module.js';
export { EngagementRepository } from './lib/engagement.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type { TalentJobEngagementView } from './lib/dto/talent-job-engagement.view.js';

export {
  ENGAGEMENT_STATE_VALUES,
  canTransition,
} from './lib/engagement-state.js';
export type { EngagementStateValue } from './lib/engagement-state.js';
