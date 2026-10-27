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
  type DocumentPageSize,
  DELETED_DRAFT_SUBJECT,
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
  SIGNER_ATTESTED_NAME_PORT,
  type SignerAttestedNamePort,
  type SignerAttestedNameQuery,
} from './lib/ports/signer-attested-name.port.js';
export {
  CHECKBOX_GROUP_RULES,
  SIGNER_NAME_MODES,
  evaluateSignerFieldRules,
  isServerFilledName,
  type CheckboxGroupRule,
  type SignerNameMode,
  type FieldRuleRow,
  type FieldRuleViolation,
} from './lib/domain/field-rules.js';
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
  SignatureFieldValueRefusedError,
  SenderFieldPassthroughRefusedError,
  EsignIdempotencyConflictError,
  EnvelopeAmbiguousError,
  ReminderNotAllowedError,
  SignerNotYetEligibleError,
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
export { SigningInvitationService, SIGNING_INVITATION_MAX_ATTEMPTS } from './lib/signing-invitation.service.js';
// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §6.4 — abuse reports.
export {
  AbuseReportService,
  ABUSE_REPORT_NOTE_MAX,
  ABUSE_REPORT_OUTCOMES,
  ABUSE_REPORT_REASONS,
  DEFAULT_ABUSE_REPORT_CONFIG,
  abuseReportConfig,
  abuseReporterKey,
  emailDomainOf,
  isAbuseReportReason,
  weighReport,
  type AbuseReportConfig,
  type AbuseReportContext,
  type AbuseReportOutcome,
  type AbuseReportReason,
  type AbuseReportView,
  type AbuseReportWeight,
  type RecordAbuseReportResult,
} from './lib/abuse-report.service.js';

// Aramo Sign Mobile — notification feed, devices, preferences, push (M-A3 §1, §2, §9).
export * from './lib/notifications/index.js';

// Aramo Sign Mobile — envelope contracts: revision preconditions, reminder limits,
// request idempotency, inbox revalidation, saved signatures, contacts (M-A2 §2.2, M-A3 §3–§9).
export {
  EnvelopeRevisionMismatchError,
  ReminderLimitError,
  InboxSigningRefusedError,
  IdempotencyKeyReuseError,
  IdempotencyRequestInProgressError,
  type ReminderLimitReason,
  type InboxSigningRefusal,
} from './lib/domain/envelope-contract-errors.js';
export {
  SIGN_REMINDER_LIMITS,
  applyReminderLimits,
  envelopeReminderAvailableAt,
  nextReminderAt,
  reminderHistory,
  type ReminderLimits,
  type ReminderHistoryEntry,
} from './lib/reminder-limits.js';
export {
  SignIdempotencyRepository,
  SIGN_IDEMPOTENCY_TTL_MS,
  SIGN_IDEMPOTENCY_KEY_MAX,
  idempotencyRequestHash,
  type SignIdempotencyScope,
  type SignIdempotencyBegin,
} from './lib/sign-idempotency.repository.js';
export {
  SignSavedSignatureRepository,
  type SavedSignatureSlot,
  type SavedSignatureKind,
  type SavedSignatureValue,
  type SavedSignatureRow,
} from './lib/sign-saved-signature.repository.js';
export { SignContactRepository, SignContactDuplicateError, contactEmailKey, type SignContactRow } from './lib/sign-contact.repository.js';
export { RECIPIENT_INBOX_SESSION_EVENT, type IssuedRecipientSession } from './lib/recipient-inbox.repository.js';
// Privacy Notice 1.1 remediation (E-1 to E-4) — retention cleanup.
export * from './lib/retention/sign-retention.repository.js';
