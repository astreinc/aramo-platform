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
