import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// Closed allowed-source vocabulary. TM-L1-A: the source values are now DERIVED
// from the single canonical source contract (../source-contract.js) so the wire
// allowlist, the source -> source_class map, and the OpenAPI enum cannot drift
// apart. Re-exported here to preserve the historical import surface
// (@aramo/ingestion, the dto barrel, and specs consume INGESTION_SOURCES /
// IngestionSource from this module).
//
// The four-layer prohibited-source enforcement (API Contracts v1.0 Phase 4
// §"Four-Layer ... Refusal Enforcement") is structurally implemented by the
// @IsIn(INGESTION_SOURCES) constraint below at the wire boundary: a request
// carrying a value outside this closed list fails class-validator at the
// controller and never reaches the service (R7 Layer 1).
import { INGESTION_SOURCES, type IngestionSource } from '../source-contract.js';

export { INGESTION_SOURCES };
export type { IngestionSource };

// POST /ingestion/payloads request body. Per API Contracts v1.0 Phase 4
// RawPayloadReference (storage_ref, sha256, content_type, captured_at)
// plus the generic-ingestion-required source identifier and optional
// dedup-supporting fields (verified_email, profile_url).
//
// tenant_id is NOT a request field — it is resolved from authContext
// at the service boundary (the libs/consent precedent).
export class IngestionPayloadRequestDto {
  @IsIn(INGESTION_SOURCES)
  source!: IngestionSource;

  @IsString()
  @MaxLength(2048)
  // S3 storage reference. PR-12 stores the reference; not the bytes
  // (Phase 4 Invariant 7: "Raw payloads are stored by reference").
  // SRC-1 PR-2 (R13.4): Invariant 7 stands. Server-originated arrivals (the
  // Indeed Apply webhook) perform their OWN upload first (ObjectStorageService
  // .putIngestionObject) and then present the resulting reference here — what
  // changed is who uploads, not the reference model.
  storage_ref!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, { message: 'sha256 must be 64 lowercase hex chars' })
  sha256!: string;

  @IsString()
  @MaxLength(255)
  content_type!: string;

  @IsISO8601()
  captured_at!: string;

  // NOTE (TM-L1-A / DDR-1 §3.3): `verified_email` is a documented misnomer — it
  // carries the channel-CLAIMED email (a caller/channel CLAIM), NOT a
  // platform-verified one. Verification level is carried by the server-derived
  // source_class, never by this field's name. Used only as a dedup-supporting
  // signal. A rename to `claimed_email` is filed non-blocking debt, deferred off
  // this bounded seam to avoid a wide DB/API/contract break (see Gate-5 report).
  @IsOptional()
  @IsString()
  @MaxLength(320)
  verified_email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  profile_url?: string;

  // TR-2a-B2 (Name-Wiring §1) — the channel-supplied structured declared name.
  // A CLAIM (caller-suppliable by nature — unlike source_class, which the DTO
  // does NOT carry): consumed only by the CONFIRMED-arm NAME guard, never an
  // identity key. Optional; MaxLength-bounded.
  @IsOptional()
  @IsString()
  @MaxLength(255)
  declared_name?: string;
}
