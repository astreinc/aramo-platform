import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { ImportModule } from '@aramo/import';

import { IntegrationController } from './integration.controller.js';
import { PrismaService } from './prisma/prisma.service.js';
import { IntegrationConnectionRepository } from './connection/integration-connection.repository.js';
import { IntegrationConnectionService } from './connection/integration-connection.service.js';
import { ConnectorDeliveryRepository } from './execution/connector-delivery.repository.js';
import { ConnectorExecutionOrchestrator } from './execution/connector-execution.orchestrator.js';
import { ConnectorExecutionService } from './execution/connector-execution.service.js';
import { ConnectorAdapterRegistry } from './adapter/connector-adapter.registry.js';
import { AwsSecretsManagerAdapter } from './secrets/aws-secrets-manager.adapter.js';
import { ConnectorSecretResolver, CONNECTION_SECRET_LOADER } from './secrets/connector-secret-resolver.js';
import { SECRETS_MANAGER_PORT } from './secrets/secrets-manager.port.js';
import { SECRETS_MANAGER_WRITER } from './secrets/secrets-manager-writer.port.js';
import { ImportServiceHandoff } from './handoff/import-service.handoff.js';
import { REQUISITION_IMPORT_HANDOFF } from './handoff/requisition-import-handoff.port.js';
import { DELIVERY_LEDGER } from './execution/delivery-ledger.port.js';
import { ConnectorAuditLog } from './observability/connector-audit.js';
// L1-D1 (ADR-0030) — external-lifecycle-authority substrate repositories.
import {
  RequisitionLifecycleMappingRepository,
  RequisitionExternalReconciliationRepository,
  RequisitionExternalTransitionProvenanceRepository,
} from './lifecycle/requisition-lifecycle-authority.repository.js';

// IntegrationModule — T8-CONNECTOR-A provider-neutral connector foundation.
//
// Boring, explicit composition root (Architect ruling): each concrete
// implementation is bound exactly ONCE; ports are wired to their impls via
// useExisting (no service-locator, no re-instantiation). Forward edges only:
//   - AuthModule / AuthorizationModule / EntitlementModule → controller guards
//   - ImportModule → ImportService (the LOCKED canonical P2 handoff)
// libs/integration imports @aramo/import; @aramo/import does NOT import
// @aramo/integration — no cycle. NO real provider adapter is registered here;
// the registry ships EMPTY (Connector-B registers concrete adapters).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, ImportModule],
  controllers: [IntegrationController],
  providers: [
    PrismaService,
    ConnectorAuditLog,
    IntegrationConnectionRepository,
    ConnectorDeliveryRepository,
    AwsSecretsManagerAdapter,
    ImportServiceHandoff,
    ConnectorSecretResolver,
    ConnectorAdapterRegistry,
    ConnectorExecutionOrchestrator,
    IntegrationConnectionService,
    ConnectorExecutionService,
    // L1-D1 (ADR-0030) — external-lifecycle-authority substrate. Pure data-access
    // seams; the governed transition runs through @aramo/requisition, composed by
    // the apps/api reconciler (no requisition write here — HARD PROHIBITION).
    RequisitionLifecycleMappingRepository,
    RequisitionExternalReconciliationRepository,
    RequisitionExternalTransitionProvenanceRepository,
    // Port → impl bindings (bound once; no duplicate instances).
    { provide: CONNECTION_SECRET_LOADER, useExisting: IntegrationConnectionRepository },
    { provide: DELIVERY_LEDGER, useExisting: ConnectorDeliveryRepository },
    { provide: SECRETS_MANAGER_PORT, useExisting: AwsSecretsManagerAdapter },
    { provide: SECRETS_MANAGER_WRITER, useExisting: AwsSecretsManagerAdapter },
    { provide: REQUISITION_IMPORT_HANDOFF, useExisting: ImportServiceHandoff },
  ],
  exports: [
    IntegrationConnectionService,
    ConnectorExecutionService,
    ConnectorAdapterRegistry,
    // COMM-B6 — the Secrets Manager READ port, so the composition root can bind a
    // Zoom webhook secret resolver (a secret-resolver, the port's sanctioned
    // consumer category). The secret id is derived server-side from config env,
    // never from client input.
    SECRETS_MANAGER_PORT,
    // L1-D1 — exported so the apps/api reconciler can compose them.
    RequisitionLifecycleMappingRepository,
    RequisitionExternalReconciliationRepository,
    RequisitionExternalTransitionProvenanceRepository,
  ],
})
export class IntegrationModule {}
