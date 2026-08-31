// @aramo/integration — T8-CONNECTOR-A provider-neutral connector foundation.

export { IntegrationModule } from './lib/integration.module.js';
export { IntegrationController } from './lib/integration.controller.js';
export { IntegrationConnectionService, ConnectionServiceError } from './lib/connection/integration-connection.service.js';
export { ConnectorExecutionService } from './lib/execution/connector-execution.service.js';
export { ConnectorAdapterRegistry } from './lib/adapter/connector-adapter.registry.js';
export type {
  ConnectorAdapter,
  ConnectorExecutionContext,
  ConnectorExecutionResult,
} from './lib/adapter/connector-adapter.port.js';
export {
  CONNECTOR_QUEUE_ATTEMPTS,
  CONNECTOR_QUEUE_BACKOFF,
  ConnectorTransientError,
} from './lib/execution/failure-taxonomy.js';
export type { ConnectorExecutionOutcome } from './lib/execution/connector-execution.orchestrator.js';
export {
  CONNECTOR_SERVICE_ACCOUNT_ID,
  CONNECTOR_EXECUTION_SCOPES,
} from './lib/domain/connector-actor.js';
// L1-D1 (ADR-0030) — External Lifecycle Authority substrate repositories + types.
export {
  RequisitionLifecycleMappingRepository,
  RequisitionExternalReconciliationRepository,
  RequisitionExternalTransitionProvenanceRepository,
  type RequisitionLifecycleAuthorityMode,
  type RequisitionLifecycleMappingResolved,
  type RecordReconciliationInput,
  type RecordProvenanceInput,
  type ClaimedReconciliationRow,
} from './lib/lifecycle/requisition-lifecycle-authority.repository.js';
// L2-I (D1) — the Pipeline provider-disposition mapping seam repositories + types.
export {
  PipelineProviderDispositionMappingRepository,
  ExternalPipelineEpisodeIdentityRepository,
  PipelineExternalReconciliationRepository,
  PipelineExternalTransitionProvenanceRepository,
  type PipelineProviderAuthorityMode,
  type PipelineDispositionMappingResolved,
  type ExternalPipelineEpisodeResolved,
  type PipelineReconciliationInput,
  type PipelineProvenanceInput,
} from './lib/lifecycle/pipeline-disposition-mapping.repository.js';
// CB-D2-R (ADR-0030, R-TAXONOMY) — the ONE authoritative reconciliation vocabulary.
export {
  RECONCILIATION_FAILURE_REASON,
  RECONCILIATION_FAILURE_REASONS,
  RECONCILIATION_DISPOSITION,
  RECONCILIATION_STATUS,
  classifyReconciliation,
  isReconciliationFailureReason,
  type ReconciliationFailureReason,
  type ReconciliationClass,
  type ReconciliationDisposition,
  type ReconciliationStatus,
} from './lib/lifecycle/reconciliation-failure-reason.js';
export {
  CONNECTION_STATUSES,
  type ConnectionStatus,
  type IntegrationConnectionView,
} from './lib/domain/integration-connection.js';
// CB-D2-A1 (ADR-0030) — provider-neutral lifecycle-ingress substrate.
export {
  LifecycleSourceAdapterRegistry,
} from './lib/lifecycle/lifecycle-source-adapter.registry.js';
export type {
  LifecycleSourceAdapter,
  LifecycleFetchContext,
  LifecycleFetchResult,
  LifecycleDelivery,
  LifecycleChange,
  ExternalRequisitionLifecycleObservation,
  ExternalRequisitionLifecycleEvent,
  LifecycleOrderingConfidence,
} from './lib/lifecycle/lifecycle-source-adapter.port.js';
export {
  LIFECYCLE_ORDERING_CONFIDENCES,
  observationKeyFor,
} from './lib/lifecycle/lifecycle-source-adapter.port.js';
export {
  LifecycleObservationLedgerRepository,
  type LifecycleObservationRow,
  type LifecycleObservationReservation,
  type LastAcceptedObservation,
  type ReserveObservationArgs,
} from './lib/lifecycle/lifecycle-observation-ledger.repository.js';
export {
  ExternalRequisitionIdentityRepository,
  type RecordIdentityInput,
} from './lib/lifecycle/external-requisition-identity.repository.js';
// L1-D3-A (R1) — VMS Lifecycle Mapping Administration: versioned mapping-set
// service + domain vocabulary. The admin allowlist is this lib's OWN bounded
// vocabulary (no @aramo/requisition runtime edge); an apps/api test asserts it
// === EXTERNAL_LIFECYCLE_ACTIONS. normalizeProviderState is the SINGLE key
// normalizer the reconciler also imports.
export {
  RequisitionLifecycleMappingAdminService,
  MappingAdminServiceError,
  MAPPING_ADMIN_AUDIT_EVENTS,
  type MappingAdminServiceErrorCode,
} from './lib/lifecycle/mapping-admin/requisition-lifecycle-mapping-admin.service.js';
export { RequisitionLifecycleMappingAdminController } from './lib/lifecycle/mapping-admin/requisition-lifecycle-mapping-admin.controller.js';
export {
  RequisitionLifecycleMappingAdminRepository,
  ActiveSetConflictError,
} from './lib/lifecycle/mapping-admin/requisition-lifecycle-mapping-admin.repository.js';
export {
  MAPPING_SET_STATUS,
  MAPPING_DISPOSITION,
  MAPPING_ADMIN_ALLOWED_ACTIONS,
  MAPPING_ADMIN_AUTHORITY_MODE,
  isMappingAdminAllowedAction,
  normalizeProviderState,
  type MappingSetStatus,
  type MappingDisposition,
  type MappingAdminAllowedAction,
  type DraftMappingRowInput,
  type MappingRowView,
  type MappingSetSummaryView,
  type MappingSetDetailView,
  type MappingValidationIssue,
  type MappingValidationCode,
} from './lib/lifecycle/mapping-admin/mapping-admin.domain.js';
// CB-D2-FG (ADR-0030) — the FIRST real provider lifecycle source (SAP Fieldglass)
// + its credential codec. Lives under provider/fieldglass/ (excluded from the
// provider-neutrality scan); registered at the apps/api composition root.
export {
  FieldglassLifecycleSource,
  FIELDGLASS_PROVIDER_KEY,
  FieldglassCredentialUnavailableError,
  FieldglassConfigError,
  parseStaffingOrderDelta,
} from './lib/lifecycle/provider/fieldglass/fieldglass-lifecycle.source.js';
export {
  encodeFieldglassCredential,
  decodeFieldglassCredential,
  FieldglassCredentialDecodeError,
  type FieldglassCredentialBundle,
} from './lib/lifecycle/provider/fieldglass/fieldglass-credential.js';
// CB-D2-FG (R-CREDENTIAL) — the tenant-bound connector secret resolver + its typed
// failure, so the apps/api lifecycle-poll producer can resolve + inject the
// ephemeral credential per connection before invoking a provider adapter.
export {
  ConnectorSecretResolver,
  ConnectorSecretResolutionError,
  type ConnectorSecretErrorCode,
} from './lib/secrets/connector-secret-resolver.js';
// CB-D2-A1 — the connection reader/writer the apps/api poll producer composes
// (active lifecycle-capable connections + the cursor WRITE path).
export { IntegrationConnectionRepository } from './lib/connection/integration-connection.repository.js';
export { redactForLog, redactString, REDACTED } from './lib/observability/redact.js';
// Ports (for composition-root overrides / Connector-B).
export { SECRETS_MANAGER_WRITER, type SecretsManagerWriterPort } from './lib/secrets/secrets-manager-writer.port.js';
export { SECRETS_MANAGER_PORT, type SecretsManagerPort } from './lib/secrets/secrets-manager.port.js';
export { PrismaService as IntegrationPrismaService } from './lib/prisma/prisma.service.js';

// Secret-ref utilities (server-side; opaque to the frontend).
export {
  buildConnectorSecretRef,
  parseConnectorSecretRef,
  assertConnectorSecretRefBinding,
  deriveConnectorSecretManagerId,
} from './lib/secrets/connector-secret-ref.js';
