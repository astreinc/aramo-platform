// @aramo/conversation-transcript — CI-V1 provider-neutral transcript metadata +
// acquisition substrate (CI-B3). No provider-specific (adapter-seam) vocabulary, no routes,
// no scopes, no consent/normalization/AI dependency. Authorized by
// Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED §3.3/§5/§7/§20/§27.

export { ConversationTranscriptModule } from './lib/conversation-transcript.module.js';
export {
  ConversationTranscriptService,
  MAX_ACQUISITION_ATTEMPTS,
  type RegisterTranscriptAvailabilityCommand,
  type AcquireTranscriptCommand,
} from './lib/conversation-transcript.service.js';
export {
  ConversationTranscriptRepository,
  type ConversationTranscriptRow,
  type OpenTranscriptRow,
  type TranscriptPatch,
} from './lib/conversation-transcript.repository.js';
export { PrismaService as ConversationTranscriptPrismaService } from './lib/prisma/prisma.service.js';

// Domain enums (provider-neutral).
export {
  TRANSCRIPT_STATES,
  TRANSCRIPT_CUSTODY_MODES,
  TRANSCRIPT_SOURCE_TYPES,
  TRANSCRIPT_RECORDING_DEPENDENCIES,
  TRANSCRIPT_SPEAKER_ROLES,
  type TranscriptState,
  type TranscriptCustodyMode,
  type TranscriptSourceType,
  type TranscriptRecordingDependency,
  type TranscriptSpeakerRole,
} from './lib/domain/transcript-enums.js';

// Transcript acquisition state machine.
export {
  TRANSCRIPT_STATE_TRANSITIONS,
  TERMINAL_TRANSCRIPT_STATES,
  isTerminalTranscriptState,
  canTranscriptTransition,
  assertTranscriptTransition,
} from './lib/domain/transcript-state-machine.js';

export {
  TranscriptInvalidStateError,
  TranscriptInteractionNotFoundError,
  TranscriptProviderReferenceConflictError,
  TranscriptAcquisitionNotAuthorizedError,
  TranscriptNotFoundError,
} from './lib/domain/errors.js';

// Provider-neutral acquisition port + capability contract + registry + fake.
export {
  CONVERSATION_TRANSCRIPT_PROVIDER,
  type ConversationTranscriptProvider,
  type TranscriptCapabilities,
  type ProviderTranscriptReference,
  type AcquireTranscriptProviderInput,
  type TranscriptAcquisitionResult,
  type TranscriptAcquisitionOutcome,
} from './lib/provider/conversation-transcript-provider.port.js';
export { ConversationTranscriptProviderRegistry } from './lib/provider/conversation-transcript-provider.registry.js';
export {
  FakeConversationTranscriptProvider,
  FAKE_TRANSCRIPT_PROVIDER_KEY,
  type FakeAcquisitionMode,
  type FakeTranscriptProviderOptions,
} from './lib/provider/fake/fake-conversation-transcript-provider.js';

// Ports bound at the composition root (interaction linkage + consent seam).
export {
  INTERACTION_REFERENCE_PORT,
  type InteractionReferencePort,
} from './lib/ports/interaction-reference.port.js';
export {
  TRANSCRIPTION_AUTHORIZATION_RESOLVER,
  isTranscriptionAuthorized,
  type TranscriptionAuthorization,
} from './lib/ports/transcription-authorization.js';

// ==== CI-B4 — canonical normalization + artifact lifecycle ====

export {
  TranscriptNormalizationService,
  MAX_NORMALIZATION_ATTEMPTS,
  type NormalizeTranscriptCommand,
} from './lib/normalization/transcript-normalization.service.js';

// Canonical normalized transcript contract (the CI-B6 input shape).
export {
  NORMALIZED_TRANSCRIPT_SCHEMA_VERSION,
  deriveUtteranceId,
  type NormalizedTranscript,
  type NormalizedUtterance,
} from './lib/normalization/normalized-transcript.js';
export { validateNormalizedTranscript } from './lib/normalization/normalized-transcript.validator.js';
export {
  canonicalize,
  canonicalStringify,
  canonicalBytes,
} from './lib/normalization/canonical-json.js';
export { sha256Hex, sha256HexUtf8 } from './lib/normalization/hashing.js';
export { normalizeUtteranceText } from './lib/normalization/text-normalization.js';

// Normalization error taxonomy.
export {
  NORMALIZATION_ERROR_CODES,
  NormalizationError,
  SourceArtifactNotFoundError,
  SourceHashMismatchError,
  SourceFormatUnsupportedError,
  SourceParseFailedError,
  NormalizedArtifactWriteError,
  NormalizationSchemaInvalidError,
  type NormalizationErrorCode,
} from './lib/normalization/normalization-errors.js';

// Provider-neutral source-parser seam + generic fixture parser.
export {
  TRANSCRIPT_SOURCE_PARSER_REGISTRY,
  type TranscriptSourceParser,
  type ParsedSourceTranscript,
  type RawTranscriptSegment,
} from './lib/normalization/transcript-source-parser.port.js';
export { TranscriptSourceParserRegistry } from './lib/normalization/transcript-source-parser.registry.js';
export {
  FixtureTranscriptParser,
  FIXTURE_TRANSCRIPT_FORMAT,
} from './lib/normalization/fixture-transcript-parser.js';

// Artifact-store port (bound at composition root) + in-memory test fake.
export {
  TRANSCRIPT_ARTIFACT_STORE,
  TranscriptArtifactWriteError,
  TranscriptArtifactNotFoundError,
  type TranscriptArtifactStore,
  type PutNormalizedInput,
  type PutSourceInput,
} from './lib/normalization/transcript-artifact-store.port.js';
export {
  InMemoryTranscriptArtifactStore,
  buildNormalizedArtifactKey,
  buildSourceArtifactKey,
  type FakeWriteMode,
} from './lib/normalization/fake/in-memory-transcript-artifact-store.js';
