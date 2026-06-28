// Public surface of @aramo/talent-trust (TR-1). The §8 interface is the only
// intended consumer entrypoint: import TalentTrustModule and inject
// TalentTrustService.

export { TalentTrustModule } from './lib/talent-trust.module.js';
export { TalentTrustService } from './lib/talent-trust.service.js';
export { TalentTrustRepository } from './lib/talent-trust.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

// §8 interface input/output shapes.
export type {
  SubjectRef,
  RecordEvidenceInput,
} from './lib/talent-trust.service.js';
export type {
  EvidenceRecordRow,
  ResolutionSubjectRow,
  TrustStateRow,
  InsertEvidenceInput,
} from './lib/talent-trust.repository.js';

// Band-derivation core (pure) — exported for downstream explainability/tests.
export {
  deriveTrustState,
  type EvidenceForDerivation,
  type DerivedTrustState,
} from './lib/band-derivation.js';
export { deriveStrength, effectiveStrength } from './lib/strength.js';

// DTO (closed-vocabulary enforcement surface, Ruling 2).
export { RecordEvidenceDto, SubjectRefDto } from './lib/dto/record-evidence.dto.js';

// Closed vocabularies (§5.2–5.5) — TS unions + @IsIn arrays.
export {
  RESOLUTION_SUBJECT_STATUSES,
  RESOLUTION_SUBJECT_REF_TYPES,
  TRUST_DIMENSIONS,
  SOURCE_CLASSES,
  METHODS,
  SEED_ASSERTION_TYPES,
  DECAY_PROFILES,
  PORTABILITY_CLASSES,
  EVIDENCE_STATUSES,
  EVIDENCE_EVENT_TYPES,
  EVIDENCE_LINK_RELATIONS,
  PRESENTATION_BANDS,
  EVENT_TO_STATUS,
} from './lib/vocab.js';
export type {
  ResolutionSubjectStatus,
  ResolutionSubjectRefType,
  TrustDimension,
  SourceClass,
  Method,
  SeedAssertionType,
  DecayProfile,
  PortabilityClass,
  EvidenceStatus,
  EvidenceEventType,
  EvidenceLinkRelation,
  PresentationBand,
} from './lib/vocab.js';
