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
