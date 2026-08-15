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
export {
  CONNECTION_STATUSES,
  type ConnectionStatus,
  type IntegrationConnectionView,
} from './lib/domain/integration-connection.js';
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
