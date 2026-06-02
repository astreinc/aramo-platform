export { ActivityModule } from './lib/activity.module.js';
export { ActivityController } from './lib/activity.controller.js';
export { ActivityRepository } from './lib/activity.repository.js';
export { PrismaService as ActivityPrismaService } from './lib/prisma/prisma.service.js';

// PR-A5a — in-tx insert helper used by @aramo/pipeline (and any future
// caller). Mirrors @aramo/metering recordUsage shape: takes a prisma
// instance + input, returns an unawaited PrismaPromise the caller
// composes into its existing $transaction([...]) array.
export {
  insertActivityInTx,
  type InsertActivityInput,
} from './lib/insert-activity.js';

export {
  ACTIVITY_TYPE_VALUES,
  isActivityType,
  type ActivityType,
  type ActivityView,
  type CreateActivityRequestDto,
} from './lib/dto/index.js';
