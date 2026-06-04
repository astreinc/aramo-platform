export { CanonicalizationModule } from './lib/canonicalization.module.js';
export { CanonicalizationService } from './lib/canonicalization.service.js';
export {
  CanonicalizationRepository,
  type CanonicalizeInput,
  type CanonicalizeResult,
  type CanonicalizeAuthContext,
  type ResolutionMethodValue,
  type UnresolvedPayloadRow,
} from './lib/canonicalization.repository.js';
export {
  CanonicalizationOutboxRepository,
  type UnpublishedOutboxEvent,
} from './lib/canonicalization-outbox.repository.js';
export {
  CanonicalizationTriggerProcessor,
  type CanonicalizationTriggerTickInput,
} from './lib/canonicalization-trigger.processor.js';
export {
  CANONICALIZATION_TRIGGER_QUEUE_NAME,
  CANONICALIZATION_TRIGGER_BATCH_SIZE,
} from './lib/canonicalization-trigger.queue.constants.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
