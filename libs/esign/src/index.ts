// @aramo/esign — the ATS-neutral Native E-Sign domain core (DOC-3).
// References Documents only by opaque UUID. Public surface for apps/esign-service.
export const ESIGN_SCHEMA = 'esign' as const;

export { PrismaService } from './lib/prisma/prisma.service.js';
export { EsignModule } from './lib/esign.module.js';
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
} from './lib/esign.service.js';
export {
  SIGNING_NOTIFICATION_PORT,
  type SigningNotificationPort,
  type SigningNotification,
  type SigningNotificationKind,
  type SigningNotificationResult,
} from './lib/ports/signing-notification.port.js';
export {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  type DocumentSourceProviderPort,
  type DocumentSourceRequest,
} from './lib/ports/document-source-provider.port.js';
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
} from './lib/domain/errors.js';
