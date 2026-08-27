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
} from './lib/lifecycle/requisition-lifecycle-authority.repository.js';
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
