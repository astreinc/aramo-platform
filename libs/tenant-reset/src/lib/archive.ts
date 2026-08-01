import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Track-0 (Tenant Reset & Archive, Directive v1.0 LOCKED §3.5–3.6) — the
// immutable archive of everything to be deleted, and its checksum.
//
// The archive is a canonical (stably key-ordered) JSON serialization of
// every to-be-deleted row across every entity, so the checksum is
// reproducible: re-serializing the same rows yields the same bytes yields
// the same SHA-256. VERIFY ARCHIVE (§3.6) re-reads the written bytes and
// re-hashes; a mismatch ABORTS before any delete (§3, steps 5–7 gate 8).

/** A canonicalized archive: the frozen rows plus reproducible metadata. */
export interface ArchivePayload {
  readonly tenant_id: string;
  readonly reason: string;
  readonly execution_commit: string;
  /** entity label ("schema.\"Table\"") -> the rows to be deleted */
  readonly entities: Record<string, ReadonlyArray<Record<string, unknown>>>;
}

/**
 * A place to write and read back the immutable archive. The default
 * writes to the local filesystem; production points it at an approved
 * location supplied at run time. The reset never embeds a location in
 * source (§4 — no production connection string / no baked location).
 */
export interface ArchiveSink {
  write(location: string, bytes: string): Promise<void>;
  read(location: string): Promise<string>;
}

/** The default filesystem sink. */
export class FileArchiveSink implements ArchiveSink {
  async write(location: string, bytes: string): Promise<void> {
    mkdirSync(dirname(location), { recursive: true });
    writeFileSync(location, bytes, { encoding: 'utf8' });
  }
  async read(location: string): Promise<string> {
    return readFileSync(location, 'utf8');
  }
}

/**
 * Recursively sort object keys so serialization is deterministic. Values
 * are otherwise passed through; Date is normalized to an ISO string so a
 * timestamptz round-trips reproducibly.
 */
function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The canonical byte string of an archive payload. */
export function serializeArchive(payload: ArchivePayload): string {
  return JSON.stringify(canonicalize(payload));
}

/** SHA-256 (hex) over the canonical bytes. */
export function checksumArchive(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
