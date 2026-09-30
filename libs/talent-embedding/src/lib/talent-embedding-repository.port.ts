import type { TalentEmbeddingStatus } from './talent-embedding-status.js';

// Enterprise Search GS-2 P5 — the persistence seam for the Talent embedding lifecycle. The worker
// (apps/api lifecycle service) depends ONLY on this port; the concrete pgvector-backed repository
// implements it in this lib. STRING token per the non-strict-lookup collision rule.
export const TALENT_EMBEDDING_REPOSITORY_PORT = 'TALENT_EMBEDDING_REPOSITORY_PORT';

/** A unit of embedding work claimed from the pending set. */
export interface TalentEmbeddingWorkItem {
  readonly tenant_id: string;
  readonly talent_record_id: string;
  readonly site_id: string | null;
}

/** The persisted descriptor used for the idempotency short-circuit (never the vector itself). */
export interface TalentEmbeddingDescriptor {
  readonly status: TalentEmbeddingStatus;
  readonly source_hash: string | null;
  readonly embedding_model: string | null;
  readonly dimension: number | null;
}

export interface TalentEmbeddingRepositoryPort {
  /** Poll a batch of pending work. */
  claimPending(limit: number): Promise<TalentEmbeddingWorkItem[]>;

  /**
   * Live Talents (cross-schema anti-join to talent_record.TalentRecord) that have NO embedding row
   * yet — the dark reconcile sweep's enqueue source. Read-only UUID-ref join (no FK, no nx code edge).
   */
  listLiveTalentRefsMissingEmbedding(limit: number): Promise<TalentEmbeddingWorkItem[]>;

  /** Enqueue/mark a subject pending (trigger: create/update/consent-change/model-bump/rebuild). */
  enqueue(input: { tenant_id: string; talent_record_id: string; site_id: string | null }): Promise<void>;

  /** Current persisted descriptor for a subject, or null if none exists yet. */
  getDescriptor(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<TalentEmbeddingDescriptor | null>;

  /** Persist a successful embedding (vector + provenance) and transition the row to `ready`. */
  saveReady(input: {
    tenant_id: string;
    talent_record_id: string;
    site_id: string | null;
    vector: readonly number[];
    source_hash: string;
    embedding_model: string;
    dimension: number;
  }): Promise<void>;

  /** Record a failed attempt (retryable) and transition the row to `failed`. */
  markFailed(input: {
    tenant_id: string;
    talent_record_id: string;
    error_message: string;
  }): Promise<void>;

  /**
   * Invalidate a subject's embedding — remove the vector row entirely. Called on a stable consent
   * revocation and when the Talent is no longer a live embeddable subject. Idempotent.
   */
  invalidate(input: { tenant_id: string; talent_record_id: string }): Promise<void>;
}
