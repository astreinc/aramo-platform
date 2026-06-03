export { CanonicalizationModule } from './lib/canonicalization.module.js';
export { CanonicalizationService } from './lib/canonicalization.service.js';
export {
  CanonicalizationRepository,
  type CanonicalizeInput,
  type CanonicalizeResult,
  type CanonicalizeAuthContext,
  type ResolutionMethodValue,
} from './lib/canonicalization.repository.js';
export {
  CanonicalizationOutboxRepository,
  type UnpublishedOutboxEvent,
} from './lib/canonicalization-outbox.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
