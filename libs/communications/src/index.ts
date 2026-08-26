// @aramo/communications — COMM-V1 provider-neutral Communications / Voice
// domain substrate (COMM-B1). No provider (Zoom) vocabulary, no routes/scopes,
// no requisition/activity dependency.

export { CommunicationsModule } from './lib/communications.module.js';
export { CommunicationsService, type TransitionOptions } from './lib/communications.service.js';
export {
  CommunicationsRepository,
  type InteractionRow,
  type InteractionStatusPatch,
  type ProviderIdentityView,
} from './lib/communications.repository.js';
export { PrismaService as CommunicationsPrismaService } from './lib/prisma/prisma.service.js';

// Canonical call state machine.
export {
  CALL_STATE_TRANSITIONS,
  TERMINAL_CALL_STATES,
  isTerminalCallState,
  canTransition,
  assertTransition,
} from './lib/domain/call-state-machine.js';

// Domain enums (provider-neutral).
export {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_INTERACTION_STATES,
  COMMUNICATION_SUBJECT_TYPES,
  COMMUNICATION_RELATION_TYPES,
  COMMUNICATION_DISPOSITION_OUTCOMES,
  COMMUNICATION_PROVIDER_EVENT_STATUSES,
  COMMUNICATION_PROVIDER_IDENTITY_STATUSES,
  type CommunicationChannel,
  type CommunicationDirection,
  type CommunicationInteractionStatus,
  type CommunicationSubjectType,
  type CommunicationRelationType,
  type CommunicationDispositionOutcome,
  type CommunicationProviderEventStatus,
  type CommunicationProviderIdentityStatus,
} from './lib/domain/communication-enums.js';

export {
  CommunicationInvalidStateError,
  CommunicationInteractionNotFoundError,
} from './lib/domain/errors.js';

// Provider port + registry + fake (provider-neutral foundation).
export { VoiceProviderRegistry } from './lib/provider/voice-provider.registry.js';
export type {
  VoiceProvider,
  VoiceCapabilities,
  IntegrationConnectionView,
  ProviderHealth,
  VoiceCallRequest,
  VoiceCallerIdentity,
  VoiceCallLaunch,
  NormalizedVoiceEvent,
  ProviderCallReference,
  NormalizedVoiceState,
} from './lib/provider/voice-provider.port.js';
export {
  FakeVoiceProvider,
  FAKE_VOICE_PROVIDER_KEY,
  type FakeProviderEvent,
} from './lib/provider/fake/fake-voice-provider.js';

// Zoom Phone adapter (COMM-B3 connection binding; live calls deferred B5/B6/B8).
export {
  ZoomPhoneAdapter,
  ZOOM_PHONE_PROVIDER_KEY,
  ZOOM_EMBED_LAUNCH_MODE,
  ZoomAdapterDeferredError,
  ZoomInitiateCallError,
  ZoomUnsupportedWebhookEventError,
} from './lib/provider/zoom/zoom-phone.adapter.js';
// COMM-B6 — Zoom webhook signature + envelope (composition-root ingress helpers).
export {
  verifyZoomWebhookSignature,
  computeZoomUrlValidationResponse,
  type ZoomSignatureInput,
  type ZoomSignatureResult,
} from './lib/provider/zoom/zoom-webhook-signature.js';
export {
  parseZoomWebhookEnvelope,
  type ZoomWebhookEnvelope,
} from './lib/provider/zoom/zoom-webhook-envelope.js';
export {
  encodeZoomCredential,
  decodeZoomCredential,
  ZoomCredentialDecodeError,
  type ZoomCredentialBundle,
} from './lib/provider/zoom/zoom-credential.js';

// COMM-B5 — comms-owned requisition existence read-port (bound at apps/api).
export {
  REQUISITION_EXISTENCE_PORT,
  type RequisitionExistencePort,
} from './lib/ports/requisition-existence.port.js';
