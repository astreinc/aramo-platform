import type {
  Assertion,
  AssertionEvent,
  AssertionLink,
  ArtifactSupport,
  DocumentTypePolicy,
  EntitledTenant,
  EvidenceArtifact,
  ExternalTalentReference,
  GoldenTalent,
  IdentityConflict,
  IntelligenceInbox,
  IntelligenceOutbox,
  IntelligenceQuarantine,
  IntelligenceReadAudit,
  IntelligenceWebhookDelivery,
  MergeSplitEvent,
  ResolvedProfileFact,
  ServiceClient,
  SubjectIdentifier,
  SubjectTrustState,
  VerificationRequest,
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
  ReadKind,
  ReadOutcome,
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
  EntitledTenant,
  EvidenceArtifact,
  ExternalTalentReference,
  GoldenTalent,
  IdentityConflict,
  IntelligenceInbox,
  IntelligenceOutbox,
  IntelligenceQuarantine,
  IntelligenceReadAudit,
  IntelligenceWebhookDelivery,
  MergeSplitEvent,
  ResolvedProfileFact,
  ServiceClient,
  SubjectIdentifier,
  SubjectTrustState,
  VerificationRequest,
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
  /** Non-merged subjects whose trust state is missing or was assessed before `assessedBefore` (oldest first). */
  listForReassessment(assessedBefore: Date, limit: number): Promise<string[]>;
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
  /** ACTIVE rows of one key, any verification status. */
  listActiveByKey(key: IdentifierKey): Promise<SubjectIdentifier[]>;
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
  listEventsFor(assertionIds: string[]): Promise<AssertionEvent[]>;
  /** Links whose from- OR to-assertion is in the set. */
  listLinksFor(assertionIds: string[]): Promise<AssertionLink[]>;
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
  listSupports(artifactIds: string[]): Promise<ArtifactSupport[]>;
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
  deleteOne(subjectId: string, factType: string, factKey: string): Promise<void>;
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
    /** Default 'golden_talent'. */
    subject_type?: string;
    subject_id: string;
    payload: JsonObject;
    occurred_at: Date;
    correlation_id?: string | null;
    causation_id?: string | null;
    tenant_id?: string | null;
  }): Promise<IntelligenceOutbox>;
  listPending(limit: number): Promise<IntelligenceOutbox[]>;
  /**
   * Lease-safe claim (FOR UPDATE SKIP LOCKED): rows not published, not
   * quarantined, whose lease is absent or expired. Each claimed row gets
   * claimed_at = now and lease_expires_at = now + leaseMs (the claim token).
   */
  claim(limit: number, now: Date, leaseMs: number): Promise<IntelligenceOutbox[]>;
  /** The guarded writes below apply only while `claimedAt` still owns the row; false = lost the lease. */
  markPublished(id: string, claimedAt: Date, at: Date): Promise<boolean>;
  markRetry(id: string, claimedAt: Date, error: string, retryAt: Date): Promise<boolean>;
  quarantine(id: string, claimedAt: Date, error: string, at: Date): Promise<boolean>;
}

export interface NewWebhookDelivery extends SourceTuple {
  outbox_event_id: string;
  reference_id: string;
  subject_id: string;
  payload: JsonObject;
}

export interface WebhookDeliveryRepository {
  /** Idempotent per (outbox_event_id, reference_id). Returns the number created. */
  createMany(rows: NewWebhookDelivery[]): Promise<number>;
  listByOutboxEvent(outboxEventId: string): Promise<IntelligenceWebhookDelivery[]>;
  claim(limit: number, now: Date, leaseMs: number): Promise<IntelligenceWebhookDelivery[]>;
  markDelivered(id: string, claimedAt: Date, at: Date): Promise<boolean>;
  markRetry(id: string, claimedAt: Date, error: string, retryAt: Date): Promise<boolean>;
  quarantine(id: string, claimedAt: Date, error: string, at: Date): Promise<boolean>;
}

export interface NewVerificationRequest {
  subject_id: string | null;
  identifier_type: 'EMAIL' | 'PHONE';
  normalized_value: string;
  channel: 'EMAIL' | 'SMS';
  code_salt: string;
  code_hash: string;
  expires_at: Date;
  max_attempts: number;
  requested_by_reference_id: string | null;
  requested_by_client_id: string;
  portal_session_id: string | null;
}

export interface VerificationRequestRepository {
  create(data: NewVerificationRequest & { id: string }): Promise<VerificationRequest>;
  findById(id: string): Promise<VerificationRequest | null>;
  /** PENDING requests for the same identifier (and subject, when given). */
  listPending(key: IdentifierKey, subjectId: string | null): Promise<VerificationRequest[]>;
  update(
    id: string,
    patch: {
      status?: 'PENDING' | 'CONFIRMED' | 'EXPIRED' | 'LOCKED';
      attempts?: number;
      outcome?: string | null;
      subject_id?: string | null;
      confirmed_at?: Date | null;
    },
  ): Promise<VerificationRequest>;
}

export interface TrustStateRow {
  identity_band: string;
  claims_band: string;
  continuity_band: string;
  eligibility_band: string;
  open_contradiction_count: number;
  stale_assertion_count: number;
  has_open_dispute: boolean;
  single_source_only: boolean;
  verification_stale: boolean;
}

export interface TrustStateRepository {
  find(subjectId: string): Promise<SubjectTrustState | null>;
  upsert(subjectId: string, row: TrustStateRow, assessedAt: Date): Promise<SubjectTrustState>;
}

export interface EntitledTenantRepository {
  find(sourceSystemId: string, tenantId: string): Promise<EntitledTenant | null>;
  upsert(sourceSystemId: string, tenantId: string, active: boolean): Promise<EntitledTenant>;
  /** Deactivate every ACTIVE tenant of the source system not in `keep`. Returns the number deactivated. */
  deactivateAllExcept(sourceSystemId: string, keep: string[]): Promise<number>;
}

export interface ReadAuditRepository {
  create(data: {
    client_id: string;
    source_system_id: string;
    source_tenant_id: string;
    external_talent_id: string;
    read_kind: ReadKind;
    outcome: ReadOutcome;
    access_mode?: string | null;
    reference_id?: string | null;
    subject_id?: string | null;
    fields_returned?: number;
  }): Promise<IntelligenceReadAudit>;
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
  verifications: VerificationRequestRepository;
  trust: TrustStateRepository;
  entitlements: EntitledTenantRepository;
  readAudit: ReadAuditRepository;
  deliveries: WebhookDeliveryRepository;
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
