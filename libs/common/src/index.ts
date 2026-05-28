export { CommonModule } from './lib/common.module.js';
export { RequestIdMiddleware } from './lib/middleware/request-id.middleware.js';
export { RequestId } from './lib/decorators/request-id.decorator.js';
export { hashCanonicalizedBody } from './lib/util/canonicalize.js';
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
