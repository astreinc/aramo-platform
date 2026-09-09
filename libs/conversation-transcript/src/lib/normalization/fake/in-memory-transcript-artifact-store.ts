// CI-B4 — in-memory TranscriptArtifactStore for tests (no real AWS; there is no
// reusable object-store fake in the repo). Enforces the same invariants the real
// adapter must: tenant-scoped opaque keys, deterministic normalized key (so
// idempotent re-writes converge), and a key that contains NO transcript text or
// PII. Content is held as opaque bytes; nothing is logged.

import { createHash } from 'node:crypto';

import {
  TranscriptArtifactNotFoundError,
  TranscriptArtifactWriteError,
  type PutNormalizedInput,
  type PutSourceInput,
  type TranscriptArtifactStore,
} from '../transcript-artifact-store.port.js';

/** Deterministic, tenant-scoped, opaque normalized-artifact key. */
export function buildNormalizedArtifactKey(tenantId: string, transcriptId: string): string {
  return `conversation-transcript/${tenantId}/${transcriptId}/normalized.json`;
}

/** Deterministic, tenant-scoped, opaque SOURCE-artifact key (raw evidence). */
export function buildSourceArtifactKey(tenantId: string, refBasis: string): string {
  return `conversation-transcript/${tenantId}/${refBasis}/source`;
}

export type FakeWriteMode = 'ok' | 'retryable' | 'terminal';

export class InMemoryTranscriptArtifactStore implements TranscriptArtifactStore {
  /** key = `${tenantId}::${ref}` → bytes. */
  private readonly objects = new Map<string, Buffer>();
  public writeMode: FakeWriteMode = 'ok';
  /** Independent failure injection for source writes (raw evidence). */
  public sourceWriteMode: FakeWriteMode = 'ok';
  public putCallCount = 0;
  public putSourceCallCount = 0;

  private key(tenantId: string, ref: string): string {
    return `${tenantId}::${ref}`;
  }

  /** Test helper: seed a source artifact at an opaque ref. */
  seedSource(tenantId: string, ref: string, bytes: Buffer): void {
    this.objects.set(this.key(tenantId, ref), bytes);
  }

  /** Test helper: read persisted bytes (returns undefined if absent). */
  peek(tenantId: string, ref: string): Buffer | undefined {
    return this.objects.get(this.key(tenantId, ref));
  }

  async putSource(input: PutSourceInput): Promise<{ ref: string; sha256: string }> {
    this.putSourceCallCount += 1;
    if (this.sourceWriteMode === 'retryable') throw new TranscriptArtifactWriteError(true);
    if (this.sourceWriteMode === 'terminal') throw new TranscriptArtifactWriteError(false);
    const ref = buildSourceArtifactKey(input.tenant_id, input.ref_basis);
    this.objects.set(this.key(input.tenant_id, ref), input.bytes);
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    return { ref, sha256 };
  }

  async getSource(tenantId: string, ref: string): Promise<Buffer> {
    const found = this.objects.get(this.key(tenantId, ref));
    if (found === undefined) throw new TranscriptArtifactNotFoundError();
    return found;
  }

  async putNormalized(input: PutNormalizedInput): Promise<{ ref: string }> {
    this.putCallCount += 1;
    if (this.writeMode === 'retryable') throw new TranscriptArtifactWriteError(true);
    if (this.writeMode === 'terminal') throw new TranscriptArtifactWriteError(false);
    const ref = buildNormalizedArtifactKey(input.tenant_id, input.transcript_id);
    this.objects.set(this.key(input.tenant_id, ref), input.bytes);
    return { ref };
  }

  async deleteNormalized(tenantId: string, ref: string): Promise<void> {
    this.objects.delete(this.key(tenantId, ref));
  }

  async deleteSource(tenantId: string, ref: string): Promise<void> {
    this.objects.delete(this.key(tenantId, ref));
  }
}
