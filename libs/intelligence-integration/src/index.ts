// @aramo/intelligence-integration — ATI-SEP-1 T8 (ADR-0036 §3): the ATS side of
// the ATS ↔ Talent Intelligence integration (scope:ats). HTTP + contracts only.
export { IntelligenceIntegrationModule } from './lib/intelligence-integration.module.js';
export {
  DEFAULT_ENTITLEMENT_SYNC_INTERVAL_MS,
  DEFAULT_INBOUND_SYNC_INTERVAL_MS,
  DEFAULT_INTELLIGENCE_HTTP_TIMEOUT_MS,
  INTELLIGENCE_INTEGRATION_CONFIG,
  loadIntelligenceConfig,
  type IntelligenceIntegrationConfig,
} from './lib/intelligence-config.js';
export {
  INTELLIGENCE_FETCH,
  IntelligenceClient,
  IntelligenceNotConfiguredError,
  IntelligenceRejectedError,
  IntelligenceUnavailableError,
  type IntelligenceFetch,
} from './lib/intelligence-client.js';
export {
  IngestPayloadRejectedError,
  buildTalentIngestRequest,
  mapWorkAuthorization,
  type BuildIngestInput,
  type BuildIngestResult,
} from './lib/ingest-payload-builder.js';
export {
  AUTO_APPLY_CAPABLE,
  DEFAULT_INTELLIGENCE_SYNC_POLICY,
  INTELLIGENCE_SYNC_FIELD_KEYS,
  SYNC_POLICY_MODES,
  decideField,
  effectiveMode,
  fieldKeysOfColumns,
  isRecruiterConfirmed,
  proposalsFromProfile,
  type FieldControl,
  type FieldDecision,
  type FieldProposal,
  type IntelligenceSyncFieldKey,
} from './lib/sync-policy.js';
export { IntelligenceEntitlementSyncService } from './lib/intelligence-entitlement-sync.service.js';
export { IntelligencePublisherHandler, type PublisherOutcome } from './lib/intelligence-publisher.handler.js';
export { INBOUND_MAX_ATTEMPTS, IntelligenceInboundSyncService, type InboundSyncResult } from './lib/intelligence-inbound-sync.service.js';
export { IntelligenceWebhookReceiver, type WebhookReceiveResult } from './lib/intelligence-webhook.receiver.js';
export {
  IdentifierSlotEmptyError,
  IntelligenceVerificationDisabledError,
  IntelligenceVerificationService,
  type VerifiableIdentifierSlot,
} from './lib/intelligence-verification.service.js';
export { IntelligenceIntegrationWorker } from './lib/intelligence-integration.worker.js';
