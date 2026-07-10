// Public surface of @aramo/talent-trust (TR-1). The §8 interface is the only
// intended consumer entrypoint: import TalentTrustModule and inject
// TalentTrustService.

export { TalentTrustModule } from './lib/talent-trust.module.js';
export { TalentTrustService } from './lib/talent-trust.service.js';
export { TalentTrustRepository } from './lib/talent-trust.repository.js';
export { SubjectMatcherService } from './lib/subject-matcher.service.js';
export { SubjectResolutionService } from './lib/subject-resolution.service.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

// §8 interface input/output shapes.
export type {
  SubjectRef,
  RecordEvidenceInput,
  RecordAnchorInput,
  DeclaredEvidenceEntry,
} from './lib/talent-trust.service.js';
export type {
  EvidenceRecordRow,
  // TR-14 B1 (DDR §2.2) — the link-graph + event-timeline read shapes for the dossier.
  EvidenceLinkRow,
  EvidenceEventRow,
  ResolutionSubjectRow,
  ResolutionSubjectRefRow,
  ReconcileTargetRow,
  SourcedPoolRow,
  DisplayIdentityEvidenceRow,
  TrustStateRow,
  InsertEvidenceInput,
  SubjectAnchorRow,
  InsertAnchorInput,
  SubjectMatchAdvisoryRow,
  UpsertMatchAdvisoryInput,
  // TR-6 B2 (DDR D5) — the PII-free advisory basis (kinds + anchor-row ids only),
  // projected to KINDS on the enriched worklist list item.
  MatchBasis,
  // TR-2a-B3b (DDR-3 §6) — the merge-operation record + ref-normalization shapes.
  SubjectMergeOperationRow,
  RefActionRecord,
  SweepStepRecord,
  CollisionRecord,
  // TR-3 B2 — the VerificationRequest row + create input (the writer's shapes).
  VerificationRequestRow,
  CreateVerificationRequestInput,
  // TR-12 B1 — the caseworker's proposal row + upsert input.
  VerificationProposalRow,
  UpsertProposalInput,
} from './lib/talent-trust.repository.js';

// TR-12 B1 (DDR §3) — the pure proposal generator (rules over Phase-2 signals),
// exported for the acceptance suite (both-ways trigger proofs) mirroring the
// band-derivation / consistency-detector cores.
export {
  generateProposals,
  type ProposalSignals,
  type OpenContradiction,
  type VerificationSlot,
  type DesiredProposal,
} from './lib/proposal-generator.js';

// TR-2a-3 advisory resolution — the merge action + reversal service input shapes
// (the service itself is exported as a value above, parallel to the matcher).
export type {
  ApproveMergeInput,
  DismissInput,
  ReverseMergeInput,
} from './lib/subject-resolution.service.js';

// TR-2a-2 within-tenant same-human matcher — the pure classifier core (exported
// for downstream explainability / tests, mirroring band-derivation).
export {
  classifyPair,
  type AnchorForMatch,
  type SharedAnchorRef,
  type MatchClassification,
} from './lib/match-classification.js';

// Band-derivation core (pure) — exported for downstream explainability/tests.
export {
  deriveTrustState,
  deriveTrustStatements,
  TRUST_STATEMENT_SINGLE_SOURCE,
  TRUST_STATEMENT_LONGITUDINAL,
  // TR-8 D2 — the staleness sentence + the engine constant.
  TRUST_STATEMENT_VERIFICATION_STALE,
  VERIFICATION_STALE_DAYS,
  type EvidenceForDerivation,
  type DerivedTrustState,
} from './lib/band-derivation.js';
export { deriveStrength, effectiveStrength, RECOMPUTE_STALENESS_DAYS } from './lib/strength.js';
// TR-2a-B1 (DDR-1 §3.4) — the confirming/non-confirming anchor projection.
export { isConfirmingAnchor } from './lib/anchor-confirmation.js';
// TR-2a-B2 (Amendment §2.2) — the CONFIRMED-arm NAME-conflict predicate.
export { namesFlatlyConflict } from './lib/name-guard.js';

// TR-4 B1 (DDR §2.1/§2.2) — the canonical claim-shape registry (pure validators/
// normalizers) + the write-path helper + the deterministic date parse table.
// B2/B3 and the acceptance suite consume these.
export {
  CANONICAL_CLAIM_SHAPES,
  validateClaimShape,
  isRegisteredAssertionType,
  parseToIsoDateOrNull,
  deriveSkillIdCanonical,
  type ClaimShapeResult,
} from './lib/canonical-claim-shapes.js';

// TR-4 B3 — the pure consistency detectors + the independence helper. Exported for
// the acceptance suite (both-ways silence proofs) and downstream reuse.
export {
  computeConsistencyPlan,
  REASON_IMPOSSIBLE_RANGE,
  REASON_EMPLOYER_CONFLICT_SAME_WINDOW,
  OVERLAP_THRESHOLD_DAYS,
  GAP_THRESHOLD_DAYS,
  type EmploymentClaim,
  type ExistingGap,
  type ConsistencyPlan,
} from './lib/consistency-detectors.js';
export { sameUltimateSource } from './lib/band-derivation.js';

// DTO (closed-vocabulary enforcement surface, Ruling 2).
export { RecordEvidenceDto, SubjectRefDto } from './lib/dto/record-evidence.dto.js';

// Closed vocabularies (§5.2–5.5) — TS unions + @IsIn arrays.
export {
  RESOLUTION_SUBJECT_STATUSES,
  RESOLUTION_SUBJECT_REF_TYPES,
  TRUST_DIMENSIONS,
  ANCHOR_KINDS,
  MATCH_ADVISE_BANDS,
  MATCH_ADVISORY_STATUSES,
  MERGE_OPERATION_KINDS,
  MATCH_RESOLUTION_ACTIONS,
  // TR-12 B1 — the caseworker's proposal vocabularies.
  PROPOSAL_KINDS,
  PROPOSAL_TRIGGER_KINDS,
  PROPOSAL_STATUSES,
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
  // TR-3 (OPEN-6, §3) — the per-dimension authoritative-assertion-type registry.
  AUTHORITATIVE_ASSERTION_TYPES,
} from './lib/vocab.js';
export type {
  ResolutionSubjectStatus,
  ResolutionSubjectRefType,
  TrustDimension,
  AnchorKind,
  MatchAdviseBand,
  MatchAdvisoryStatus,
  MergeOperationKind,
  MatchResolutionAction,
  ProposalKind,
  ProposalTriggerKind,
  ProposalStatus,
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
