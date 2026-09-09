// CI-B4 — the transcript artifact-store PORT (directive §object-storage). B4
// reads the SOURCE artifact and writes the NORMALIZED artifact through this
// tenant-scoped, opaque-ref abstraction. It deliberately does NOT import
// @aramo/object-storage: the concrete adapter (over ObjectStorageService,
// encrypted at rest, no public URL) is bound at the composition root — same
// pattern as B3's INTERACTION_REFERENCE_PORT — keeping this a zero-nx-edge leaf
// and letting tests bind an in-memory fake with no real AWS.
//
// Invariants the concrete adapter MUST uphold: tenant-scoped keys, no public
// access, no transcript text or PII in the key, encryption at rest, and refs
// that are opaque handles (never a URL). Content NEVER flows through logs.

/** Retryable classification for a write failure (drives retry vs terminal). */
export class TranscriptArtifactWriteError extends Error {
  readonly retryable: boolean;
  constructor(retryable: boolean) {
    super('transcript artifact write failed');
    this.name = 'TranscriptArtifactWriteError';
    this.retryable = retryable;
  }
}

/** The requested artifact ref does not exist / is unreadable. */
export class TranscriptArtifactNotFoundError extends Error {
  constructor() {
    super('transcript artifact not found');
    this.name = 'TranscriptArtifactNotFoundError';
  }
}

export interface PutNormalizedInput {
  readonly tenant_id: string;
  readonly transcript_id: string;
  /** Canonical UTF-8 bytes to persist (already serialized + hashed). */
  readonly bytes: Buffer;
}

export interface PutSourceInput {
  readonly tenant_id: string;
  /**
   * Opaque, caller-supplied stable key basis for the source object. The
   * acquisition adapter supplies its provider identity (e.g.
   * `zoom_phone/<provider_transcript_id>`) because it does not hold the
   * aggregate id at write time; the store treats it as an opaque path segment.
   * Must be deterministic per provider transcript so re-writes converge.
   */
  readonly ref_basis: string;
  /** Raw provider SOURCE transcript bytes — durable evidence, never mutated. */
  readonly bytes: Buffer;
}

export interface TranscriptArtifactStore {
  /**
   * Write the raw SOURCE artifact (provider transcript evidence); returns its
   * opaque ref + server-computed SHA-256. Deterministic key for a given
   * (tenant, transcript) so idempotent re-writes converge on the same ref (CI-B5
   * raw-evidence capture — the gap B3/B4 left: no source-byte write path existed).
   * Throws {@link TranscriptArtifactWriteError} on failure.
   */
  putSource(input: PutSourceInput): Promise<{ ref: string; sha256: string }>;

  /**
   * Read SOURCE artifact bytes by opaque, tenant-scoped ref. Throws
   * {@link TranscriptArtifactNotFoundError} when absent (tenant-safe: another
   * tenant's ref is "not found").
   */
  getSource(tenantId: string, ref: string): Promise<Buffer>;

  /**
   * Write the NORMALIZED artifact; returns its opaque ref. Deterministic key for
   * a given (tenant, transcript) so idempotent re-writes converge. Throws
   * {@link TranscriptArtifactWriteError} on failure.
   */
  putNormalized(input: PutNormalizedInput): Promise<{ ref: string }>;

  /** Delete the NORMALIZED artifact by ref (idempotent; no-op if absent). */
  deleteNormalized(tenantId: string, ref: string): Promise<void>;

  /** Delete the SOURCE artifact by ref (idempotent; no-op if absent). */
  deleteSource(tenantId: string, ref: string): Promise<void>;
}

/** DI token; the concrete adapter is bound at the composition root. */
export const TRANSCRIPT_ARTIFACT_STORE = 'TRANSCRIPT_ARTIFACT_STORE';
