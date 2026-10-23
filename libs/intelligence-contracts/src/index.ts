// @aramo/intelligence-contracts — the ONLY code shared between the ATS and the
// Talent Intelligence (TI) service (ADR-0036 Decision 1). Event names, the
// envelope version and the wire DTOs. No domain logic, no persistence, no
// import of any ATS or TI library (scope:shared leaf).
export {
  ATS_TALENT_EVENT_TYPES,
  EVENT_VERSION,
  GOLDEN_TALENT_PROFILE_UPDATED,
  INTELLIGENCE_EVENT_TYPES,
  SOURCE_SYSTEM_ARAMO_ATS,
  TALENT_CREATED,
  TALENT_ERASED,
  TALENT_PROFILE_UPDATED,
  isAtsTalentEventType,
  isIntelligenceEventType,
  type AtsTalentEventType,
  type EventVersion,
  type IntelligenceEventType,
  type SourceSystemId,
} from './lib/events.js';
export {
  isAtsTalentEventEnvelope,
  type AtsTalentEventEnvelope,
  type GoldenTalentProfileUpdatedEnvelope,
} from './lib/envelope.js';
export {
  INTELLIGENCE_SERVICE_NAME,
  type IntelligenceHealthResponse,
  type IntelligenceProfileReadResponse,
  type TalentIngestionRequest,
  type TalentIngestionResponse,
} from './lib/api.js';
