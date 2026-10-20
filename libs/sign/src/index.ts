// @aramo/sign — the ATS-neutral Native E-Sign domain core (DOC-3).
// References Documents only by opaque UUID. Public surface for apps/sign-service.
export const ESIGN_SCHEMA = 'sign' as const;

export { PrismaService } from './lib/prisma/prisma.service.js';
export { EsignModule } from './lib/esign.module.js';
export {
  EsignSenderRepository,
  type SenderEnvelopeListFilter,
  type SenderRecipientInput,
  type SenderFieldInput,
  type SenderDocumentRow,
} from './lib/sender-workspace.repository.js';
export {
  EsignRepository,
  type CreateEnvelopeInput,
  type AddDocumentInput,
  type AddSignerInput,
  type AddFieldInput,
  type AppendEventInput,
} from './lib/esign.repository.js';
export {
  EsignService,
  type IssuedSession,
  type SessionContext,
  type SignerFieldView,
  type SignerDocumentMeta,
  type SignerDocumentView,
  type SignerSourceDescriptor,
  ENVELOPE_TTL_DAYS_DEFAULT,
  envelopeExpiresAt,
} from './lib/esign.service.js';
export {
  SIGNING_NOTIFICATION_PORT,
  type SigningNotificationPort,
  type SigningNotification,
  type SigningNotificationKind,
  type SigningNotificationAudience,
  type SigningNotificationResult,
} from './lib/ports/signing-notification.port.js';
export {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  type DocumentSourceProviderPort,
  type DocumentSourceRequest,
  type EnvelopeDocumentSourceMode,
} from './lib/ports/document-source-provider.port.js';
export {
  DOCUMENT_STORAGE_PORT,
  type DocumentStoragePort,
  type PutOwnedSourceInput,
  type PutOwnedSourceResult,
} from './lib/ports/document-storage.port.js';
export {
  EXECUTION_PRODUCER_PORT,
  type ExecutionProducerPort,
  type ExecutedProductionResult,
} from './lib/ports/execution-producer.port.js';
export { ExecutionService } from './lib/execution.service.js';
export {
  EVENT_PUBLISHER_PORT,
  LocalEventPublisher,
  type EventPublisherPort,
  type EsignDomainEvent,
} from './lib/ports/event-publisher.port.js';
export { OutboxService } from './lib/outbox.service.js';
export { OutboxDeliveryService, type DeliveryBatchResult } from './lib/outbox-delivery.service.js';
export { backoffMs } from './lib/outbox-backoff.js';
export {
  ESIGN_LIFECYCLE_EVENT_VERSION,
  toLifecycleEvent,
  type EsignLifecycleEvent,
  type EsignLifecycleEventArtifactRefs,
  type OutboxRowForLifecycleEvent,
} from './lib/ports/lifecycle-event.js';
export {
  WEBHOOK_DELIVERY_PORT,
  type WebhookDeliveryPort,
  type WebhookDeliveryResult,
} from './lib/ports/webhook-delivery.port.js';
export {
  EVIDENCE_MANIFEST_SIGNER_PORT,
  SoftwareEvidenceManifestSigner,
  type EvidenceManifestSignerPort,
  type EvidenceManifest,
  type SignedEvidenceManifest,
} from './lib/ports/evidence-manifest-signer.port.js';
export {
  generateSigningToken,
  hashSigningToken,
  signingSessionExpiresAt,
  SIGNING_TOKEN_BYTES,
  SIGNING_SESSION_TTL_MS,
} from './lib/signing-token.js';
export { computeEventHash, type EventHashInput } from './lib/hash-chain.js';
export {
  EnvelopeNotFoundError,
  EnvelopeIllegalTransitionError,
  EnvelopeAlreadyExecutedError,
  SignerNotFoundError,
  SigningSessionInvalidError,
  SigningSessionExpiredError,
  DisclosureNotAcceptedError,
  SignatureFieldIncompleteError,
  EsignIdempotencyConflictError,
  EnvelopeAmbiguousError,
  ReminderNotAllowedError,
  DisclosureVersionInvalidError,
} from './lib/domain/errors.js';
// Aramo Sign launch — server-held disclosure, lifecycle notifications, sender lookup.
export {
  CURRENT_DISCLOSURE_VERSION,
  currentDisclosure,
  findDisclosure,
  listDisclosures,
  DISCLOSURE_V2_TEXT,
  type DisclosureVersion,
} from './lib/domain/disclosure.js';
export {
  EnvelopeNotificationService,
  ENVELOPE_NOTIFICATION_SERVICE,
  EXECUTED_ACCESS_TTL_DAYS_DEFAULT,
} from './lib/envelope-notification.service.js';
export { SENDER_DIRECTORY_PORT, type SenderDirectoryPort, type SenderContact } from './lib/ports/sender-directory.port.js';
export { STORAGE_ACCOUNTING_PORT, type StorageAccountingPort } from './lib/ports/storage-accounting.port.js';

// Sign Unified Product S-2 — the one Sign base-URL setting.
export { signBaseUrl, DEFAULT_SIGN_BASE_URL } from './lib/sign-base-url.js';
// Sign Unified Product S-4 — the Sign-owned application registry and installations.
export {
  SignIntegrationRepository,
  type InstallationGrant,
  type SignApplicationRow,
  type SignInstallationRow,
  type SignCredentialRow,
  type SignAccessTokenRow,
  type SignRoleMappingRow,
  type InstallationWithApp,
  type InstallationFull,
  type InstallationListed,
  SignWebhookRepository,
  type SignWebhookSubscriptionRow,
  type SignWebhookDeliveryRow,
} from './lib/integration.repository.js';
// Sign Unified Product S-7 — the recipient inbox (refinement B).
export { RecipientInboxRepository, RECIPIENT_SESSION_TTL_MS, RECIPIENT_COPY_TTL_MS, type RecipientInboxRow } from './lib/recipient-inbox.repository.js';
export { canonicalSignEventType } from './lib/event-type.js';
