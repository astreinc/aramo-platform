import type {
  Assertion,
  AssertionEvent,
  AssertionLink,
  ArtifactSupport,
  DocumentTypePolicy,
  EvidenceArtifact,
  ExternalTalentReference,
  GoldenTalent,
  IdentityConflict,
  IntelligenceInbox,
  IntelligenceOutbox,
  IntelligenceQuarantine,
  MergeSplitEvent,
  ResolvedProfileFact,
  ServiceClient,
  SubjectIdentifier,
} from '../../../prisma/generated/client/client.js';
import type {
  AccessState,
  AssertionEventType,
  AssertionLinkType,
  AssertionStatus,
  AssertionVerification,
  IdentifierStatus,
  IdentifierType,
  IdentifierVerification,
  IdentityConflictStatus,
  IdentityConflictType,
  InboxKind,
  MergeSplitKind,
  ReferenceStatus,
  ResolutionStatus,
} from '../vocabulary.js';

// ATI-SEP-1 T1 — repository CONTRACTS for every intelligence table. The Prisma
// implementations (prisma-repositories.ts) bind to a transaction client; the
// domain services depend only on these interfaces (unit-testable in memory).

export type {
  Assertion,
  AssertionEvent,
  AssertionLink,
  ArtifactSupport,
  DocumentTypePolicy,
  EvidenceArtifact,
  ExternalTalentReference,
  GoldenTalent,
  IdentityConflict,
  IntelligenceInbox,
  IntelligenceOutbox,
  IntelligenceQuarantine,
  MergeSplitEvent,
  ResolvedProfileFact,
  ServiceClient,
  SubjectIdentifier,
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface SourceTuple {
  source_system_id: string;
  source_tenant_id: string;
  external_talent_id: string;
}

export interface IdentifierKey {
  identifier_type: IdentifierType;
  normalized_value: string;
}

export interface GoldenTalentRepository {
  create(data: { resolution_status: ResolutionStatus; access_state?: AccessState }): Promise<GoldenTalent>;
  findById(id: string): Promise<GoldenTalent | null>;
  update(
    id: string,
    patch: { resolution_status?: ResolutionStatus; merged_into_id?: string | null; access_state?: AccessState },
  ): Promise<GoldenTalent>;
}

export interface NewSubjectIdentifier extends IdentifierKey {
  subject_id: string;
  jurisdiction?: string | null;
  identifier_class?: string | null;
  verification_status: IdentifierVerification;
  verification_method?: string | null;
  verification_source?: string | null;
  verified_at?: Date | null;
  valid_from?: Date | null;
  is_primary: boolean;
  source_reference_id?: string | null;
}

export interface SubjectIdentifierRepository {
  /** ACTIVE + VERIFIED rows for any of the keys (the partial-unique-index population). */
  findActiveVerified(keys: IdentifierKey[]): Promise<SubjectIdentifier[]>;
  listBySubject(subjectId: string): Promise<SubjectIdentifier[]>;
  listActiveByReference(referenceId: string): Promise<SubjectIdentifier[]>;
  create(data: NewSubjectIdentifier): Promise<SubjectIdentifier>;
  update(
    id: string,
    patch: {
      status?: IdentifierStatus;
      valid_to?: Date | null;
      verification_status?: IdentifierVerification;
      verification_method?: string | null;
      verification_source?: string | null;
      verified_at?: Date | null;
      is_primary?: boolean;
    },
  ): Promise<SubjectIdentifier>;
  repoint(ids: string[], subjectId: string): Promise<void>;
}

export interface ExternalTalentReferenceRepository {
  findByTuple(tuple: SourceTuple): Promise<ExternalTalentReference | null>;
  findById(id: string): Promise<ExternalTalentReference | null>;
  create(data: SourceTuple & { subject_id: string; last_identity_snapshot: JsonObject }): Promise<ExternalTalentReference>;
  update(
    id: string,
    patch: { last_identity_snapshot?: JsonObject; status?: ReferenceStatus; erased_at?: Date | null },
  ): Promise<ExternalTalentReference>;
  listBySubject(subjectId: string): Promise<ExternalTalentReference[]>;
  repoint(ids: string[], subjectId: string): Promise<void>;
}

export interface NewAssertion {
  subject_id: string;
  assertion_type: string;
  admission_class: 'A' | 'B';
  payload: JsonObject;
  source_reference_id: string | null;
  source_system_id: string;
  source_tenant_id: string | null;
  source_kind: string;
  source_event_id: string;
  verification_status: AssertionVerification;
  observed_at: Date;
  valid_from: Date | null;
  valid_to: Date | null;
  ai_derived: boolean;
  content_hash: string;
  source_document_hash: string | null;
}

export interface AssertionRepository {
  create(data: NewAssertion): Promise<Assertion>;
  findById(id: string): Promise<Assertion | null>;
  /** Assertions of a reference whose status is not SUPERSEDED / WITHDRAWN / REVOKED. */
  listLiveByReference(referenceId: string): Promise<Assertion[]>;
  listBySubject(subjectId: string): Promise<Assertion[]>;
  setStatus(id: string, status: AssertionStatus): Promise<void>;
  /** Re-point to another subject — only inside a repoint-enabled unit of work. */
  repoint(ids: string[], subjectId: string): Promise<void>;
  appendEvent(data: {
    assertion_id: string;
    event_type: AssertionEventType;
    from_status?: AssertionStatus | null;
    to_status?: AssertionStatus | null;
    actor: string;
    source_event_id?: string | null;
    details?: JsonObject | null;
  }): Promise<AssertionEvent>;
  listEvents(assertionId: string): Promise<AssertionEvent[]>;
  appendLink(data: {
    from_assertion_id: string;
    to_assertion_id: string;
    link_type: AssertionLinkType;
    actor: string;
  }): Promise<AssertionLink>;
}

export interface EvidenceArtifactRepository {
  upsertPolicy(documentType: string, globallyShareable: boolean): Promise<DocumentTypePolicy>;
  findPolicy(documentType: string): Promise<DocumentTypePolicy | null>;
  create(data: {
    subject_id: string;
    document_type: string;
    issuer?: string | null;
    storage_key: string;
    sha256: string;
    retrieved_at: Date;
    source_url?: string | null;
  }): Promise<EvidenceArtifact>;
  listBySubject(subjectId: string): Promise<EvidenceArtifact[]>;
  addSupport(assertionId: string, artifactId: string): Promise<ArtifactSupport>;
  repoint(ids: string[], subjectId: string): Promise<void>;
}

export interface ResolvedProfileFactRepository {
  upsert(data: {
    subject_id: string;
    fact_type: string;
    fact_key: string;
    value: JsonValue;
    supporting_assertion_ids: string[];
  }): Promise<ResolvedProfileFact>;
  listBySubject(subjectId: string): Promise<ResolvedProfileFact[]>;
  /** Projection rows are recomputable — dropping them (on merge/split) is safe. */
  deleteBySubject(subjectId: string): Promise<number>;
}

export interface IdentityConflictRepository {
  create(data: {
    subject_id: string;
    conflict_type: IdentityConflictType;
    related_subject_ids?: string[];
    details: JsonObject;
  }): Promise<IdentityConflict>;
  listBySubject(subjectId: string, status?: IdentityConflictStatus): Promise<IdentityConflict[]>;
  resolve(id: string): Promise<IdentityConflict>;
  repoint(ids: string[], subjectId: string): Promise<void>;
}

export interface MergeSplitEventRepository {
  create(data: {
    kind: MergeSplitKind;
    from_subject_id: string;
    into_subject_id: string;
    actor: string;
    reason: string;
    moved: JsonObject;
  }): Promise<MergeSplitEvent>;
  findById(id: string): Promise<MergeSplitEvent | null>;
  listBySubject(subjectId: string): Promise<MergeSplitEvent[]>;
}

export interface IntelligenceInboxRepository {
  find(eventId: string): Promise<IntelligenceInbox | null>;
  create(data: SourceTuple & { event_id: string; kind: InboxKind; outcome: string; response: JsonObject }): Promise<IntelligenceInbox>;
}

export interface IntelligenceQuarantineRepository {
  create(data: {
    source_system_id?: string | null;
    source_event_id?: string | null;
    client_id?: string | null;
    reason: string;
    issues: JsonValue;
  }): Promise<IntelligenceQuarantine>;
}

export interface IntelligenceOutboxRepository {
  enqueue(data: {
    event_type: string;
    subject_id: string;
    payload: JsonObject;
    occurred_at: Date;
    correlation_id?: string | null;
    causation_id?: string | null;
    tenant_id?: string | null;
  }): Promise<IntelligenceOutbox>;
  listPending(limit: number): Promise<IntelligenceOutbox[]>;
}

export interface ServiceClientRepository {
  find(clientId: string): Promise<ServiceClient | null>;
  upsert(data: {
    client_id: string;
    secret_hash: string;
    allowed_scopes: string[];
    source_system_id: string;
    active: boolean;
  }): Promise<ServiceClient>;
}

/** Every repository bound to ONE transaction. */
export interface IntelligenceRepositories {
  subjects: GoldenTalentRepository;
  identifiers: SubjectIdentifierRepository;
  references: ExternalTalentReferenceRepository;
  assertions: AssertionRepository;
  artifacts: EvidenceArtifactRepository;
  facts: ResolvedProfileFactRepository;
  conflicts: IdentityConflictRepository;
  mergeSplit: MergeSplitEventRepository;
  inbox: IntelligenceInboxRepository;
  quarantine: IntelligenceQuarantineRepository;
  outbox: IntelligenceOutboxRepository;
  clients: ServiceClientRepository;
}

export interface UnitOfWorkOptions {
  /**
   * Transaction-scoped advisory locks (pg_advisory_xact_lock), taken in sorted
   * order before `fn` runs — serializes ingests that touch the same reference
   * or the same verified identifier.
   */
  lockKeys?: string[];
  /** Enables Assertion.subject_id re-pointing (merge / split) for this transaction only. */
  repoint?: boolean;
}

/** Runs `fn` atomically: all writes commit together or none do. */
export interface IntelligenceUnitOfWork {
  run<T>(fn: (repos: IntelligenceRepositories) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

export const INTELLIGENCE_UNIT_OF_WORK = Symbol('INTELLIGENCE_UNIT_OF_WORK');
