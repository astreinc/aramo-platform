// @aramo/intelligence-core — Talent Intelligence persistence + domain core
// (ATI-SEP-1, ADR-0036). scope:intelligence: never imported by an ATS or
// Pipeline library; never imports one.
export { IntelligenceCoreModule } from './lib/intelligence-core.module.js';
export { IntelligenceHealthService } from './lib/intelligence-health.service.js';
export { IntelligencePrismaService } from './lib/prisma/intelligence-prisma.service.js';
export {
  INTELLIGENCE_DATABASE_URL_ENV,
  IntelligenceDatabaseConfigError,
  resolveIntelligenceDatabaseUrl,
} from './lib/prisma/intelligence-database-url.js';

// T1 — model vocabulary, repositories, unit of work.
export * from './lib/vocabulary.js';
export * from './lib/repositories/types.js';
export { createPrismaRepositories, type IntelligenceDb } from './lib/repositories/prisma-repositories.js';
export { PrismaIntelligenceUnitOfWork } from './lib/repositories/prisma-unit-of-work.js';
export {
  GovIdTokenizationUnavailableError,
  GovIdTokenizer,
  INTELLIGENCE_GOV_ID_TOKEN_KEY_ENV,
  canonicalJson,
  namesConflict,
  namesMatch,
  normalizeEmail,
  normalizeNames,
  normalizePhone,
  sha256Hex,
  type NameSnapshot,
} from './lib/normalize.js';

// T3 — identity resolution + merge / split.
export {
  decideResolution,
  identifierKey,
  isMaterialIdentityChange,
  type IdentitySnapshot,
  type PlannedConflict,
  type ResolutionDecision,
  type ResolutionFacts,
  type VerifiedAnchorMatch,
} from './lib/identity/identity-resolution.js';
export {
  IdentityResolutionService,
  ReferenceErasedError,
  dedupeIdentifiers,
  snapshotOf,
  survivingSubject,
  type ResolutionIdentifier,
  type ResolutionInput,
  type ResolutionResult,
} from './lib/identity/identity-resolution.service.js';
export {
  IdentityMergeSplitService,
  MergeSplitError,
  type MergeMoved,
  type MovedSet,
  type SplitSelection,
} from './lib/identity/merge-split.service.js';

// T2 — ingestion + service tokens.
export {
  assertionContentHash,
  toAssertionDrafts,
  toResolutionInput,
  type AssertionDraft,
} from './lib/ingest/ingest-mapping.js';
export {
  EventIdReusedError,
  GOV_ID_TOKENIZER,
  IngestRejectedError,
  SourceSystemMismatchError,
  TalentIngestService,
  referenceLockKey,
  type IngestPrincipal,
} from './lib/ingest/talent-ingest.service.js';
export {
  INTELLIGENCE_SERVICE_TOKEN_SECRET_ENV,
  SERVICE_TOKEN_AUDIENCE,
  SERVICE_TOKEN_ISSUER,
  SERVICE_TOKEN_TTL_SECONDS,
  ServiceTokenError,
  ServiceTokenService,
  hashClientSecret,
  verifyClientSecret,
  type ServicePrincipal,
  type ServiceTokenErrorCode,
} from './lib/auth/service-token.service.js';
export {
  ServiceClientProvisioningError,
  provisionServiceClient,
  type ProvisionServiceClientInput,
  type ProvisionServiceClientResult,
} from './lib/auth/service-client-provisioning.js';

// T5 — projection, trust, re-assessment.
export {
  DEFAULT_AVAILABILITY_FRESHNESS_DAYS,
  compatible,
  computeProjection,
  identifierDigest,
  isTimeStale,
  orderFacts,
  type ProjectedFact,
  type ProjectionAssertion,
  type ProjectionIdentifier,
  type ProjectionOptions,
  type ProjectionResult,
} from './lib/projection/projection.js';
export { VERIFICATION_STALE_DAYS, deriveTrust, dimensionOf, independenceKey, type TrustAssertion } from './lib/projection/trust-derivation.js';
export {
  DEFAULT_REASSESSMENT_INTERVAL_MS,
  PROJECTION_TRIGGER,
  PROPOSAL_SETTLED_JUSTIFICATION,
  ProjectionService,
  TI_AVAILABILITY_FRESHNESS_DAYS_ENV,
  TI_REASSESSMENT_INTERVAL_MS_ENV,
  availabilityFreshnessDays,
  reassessmentIntervalMs,
  type ProjectionTrigger,
  type RebuildResult,
} from './lib/projection/projection.service.js';

// T4 — verification.
export {
  INTELLIGENCE_VERIFICATION_CODE_KEY_ENV,
  VERIFICATION_CODE_SERVICE,
  VerificationCodeService,
  VerificationUnavailableError,
} from './lib/verification/verification-code.js';
export {
  LogVerificationDeliveryAdapter,
  VERIFICATION_DELIVERY_PORT,
  maskDestination,
  type VerificationDeliveryPort,
  type VerificationDeliveryResult,
  type VerificationMessage,
} from './lib/verification/verification-delivery.js';
export {
  MailerVerificationDeliveryAdapter,
  VerificationDeliveryModule,
  mailerConfigured,
  renderVerificationCodeEmail,
  selectVerificationDelivery,
} from './lib/verification/mailer-verification-delivery.js';
export { VerificationRefusedError, VerificationService, type ConfirmResult } from './lib/verification/verification.service.js';

// T6 — read API + entitlements.
export { ProfileReadService, ReadRefusedError } from './lib/access/profile-read.service.js';
export {
  TI_CROSS_TENANT_READ_ENABLED_ENV,
  activeReferenceTenants,
  assertionVisibleTo,
  crossTenantReadEnabled,
  isOwnAssertion,
  isTiOriginated,
  reconciledPairs,
  tenantViewAssertions,
  tenantViewIdentifiers,
} from './lib/access/tenant-view.js';
export { EntitlementService, EntitlementSyncInvalidError, validateEntitlementSync } from './lib/access/entitlement.service.js';

// T7 — outbox drain.
export {
  FetchWebhookTransport,
  INTELLIGENCE_OUTBOX_MAX_ATTEMPTS_ENV,
  IntelligenceOutboxDrainService,
  WEBHOOK_TRANSPORT,
  backoffMs,
  drainConfigFromEnv,
  type DrainConfig,
  type DrainReport,
  type WebhookTransport,
} from './lib/outbox/outbox-drain.service.js';

// T10 — evidence lifecycle (Addendum A3 T10-2 / T10-3).
export {
  LifecycleRefusedError,
  decodeCursor,
  encodeCursor,
  pageLimit,
  requireActiveReference,
  requireEntitledTenant,
  tenantActor,
  tenantReferencesOn,
} from './lib/lifecycle/lifecycle-access.js';
export { generateProposals, type DesiredProposal } from './lib/lifecycle/proposal-generator.js';
export { DISPUTE_WITHDRAWAL_JUSTIFICATION, DisputeService, disputeSla } from './lib/lifecycle/dispute.service.js';
export { ProposalService } from './lib/lifecycle/proposal.service.js';
export { ContradictionResolutionService } from './lib/lifecycle/contradiction-resolution.service.js';
export { VerificationStatusService } from './lib/verification/verification-status.service.js';
