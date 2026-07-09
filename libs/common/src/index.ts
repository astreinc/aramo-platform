export { CommonModule } from './lib/common.module.js';
export { RequestIdMiddleware } from './lib/middleware/request-id.middleware.js';
export { RequestId } from './lib/decorators/request-id.decorator.js';
export { hashCanonicalizedBody } from './lib/util/canonicalize.js';
// Step 4a (ADR-0016) — tenant-side email fingerprint primitive for the
// cross-tenant identity privacy wall (I14). The raw email stays tenant-side;
// only the opaque fingerprint crosses into the PII-free identity_index.
export {
  computeEmailFingerprint,
  normalizeEmail,
  loadIdentityPepper,
} from './lib/util/identity-fingerprint.js';
// TR-2a-1 — deterministic within-tenant phone normalizer (digit-strip, no LLM).
export { normalizePhone } from './lib/util/normalize-phone.js';
export {
  AramoError,
  AramoExceptionFilter,
  ERROR_CODES,
} from './lib/errors/index.js';
export type { AramoErrorContext, ErrorCode } from './lib/errors/index.js';
export { CONTACT_CHANNELS } from './lib/types/contact-channel.js';
export type { ContactChannel } from './lib/types/contact-channel.js';
export { CONSENT_SCOPE_STATUSES } from './lib/types/consent-scope-status.js';
export type { ConsentScopeStatus } from './lib/types/consent-scope-status.js';
// AUTHZ-D4b — structural VisibilityContext shape + Request augmentation
// (see file header). Allows entity libs to consume the resolved context
// without importing @aramo/visibility — the Gate-5 cycle-avoidance.
// The side-effect import installs the express-serve-static-core augmentation.
import './lib/types/visibility-context.js';
export type { VisibilityContextShape } from './lib/types/visibility-context.js';
export {
  createAramoLogger,
  makeMockLogger,
  type AramoLogPayload,
  type AramoLogger,
} from './lib/logging/index.js';
export {
  RedisConnectionConfig,
  type RedisConnectionOptions,
} from './lib/redis/redis-connection.config.js';
// M5 PR-11 Gate 5-redux: cross-schema-consistency moved from CommonModule
// to dedicated CrossSchemaConsistencyModule (PL-88 ratification). The
// processor + repository + queue constants still live in libs/common/src/lib/
// but are now wired exclusively via the dedicated module. AppModule
// imports CrossSchemaConsistencyModule directly; CommonModule no longer
// surfaces BullMQ Workers.
export { CrossSchemaConsistencyModule } from './lib/cross-schema-consistency/cross-schema-consistency.module.js';
export {
  CrossSchemaConsistencyProcessor,
} from './lib/cross-schema-consistency.processor.js';
export type { CrossSchemaConsistencyScanInput } from './lib/cross-schema-consistency.processor.js';
export {
  CrossSchemaConsistencyRepository,
} from './lib/cross-schema-consistency.repository.js';
export type {
  CrossSchemaPairResult,
  OrphanedReferenceSample,
} from './lib/cross-schema-consistency.repository.js';
export { CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME } from './lib/cross-schema-consistency.queue.constants.js';
// A8-3b — no-LLM-boundary assertion helper, lifted from the A8-2 spec.
// ADR-0015 Decision 10 enforces "AI isolated to ai-draft" via structural
// specs in each consumer lib (libs/import A8-2; libs/resume-parse A8-3b).
// The helper is the single source of truth so the two specs cannot drift.
export {
  findNoLlmBoundaryViolations,
  assertModuleHasNoLlmImports,
  type NoLlmBoundaryViolation,
} from './lib/testing/no-llm-boundary-assertion.js';

// Platform-Console Inc-2 PR-1.5 Workstream C — the shared identity
// migration-registration helper (single ordered source of truth so the next
// identity migration is a one-line edit, not a 23-site sweep).
export {
  IDENTITY_MIGRATIONS,
  resolveIdentityMigrations,
} from './lib/testing/identity-migrations.js';
