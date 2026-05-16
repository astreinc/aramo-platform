import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

// Closed allowed-source vocabulary per API Contracts v1.0 Phase 4
// "Allowed Adapter Types". The four-layer prohibited-source enforcement
// (Phase 4 §"Four-Layer ... Refusal Enforcement") is structurally
// implemented by this @IsIn(...) constraint at the wire boundary: a
// request carrying a value outside this list fails class-validator
// at the controller and never reaches the service. PR-12 ships the
// closed-enum layer only; the Pact prohibited-source-type test that
// validates the rejection externally is PR-14 scope per directive §5.
export const INGESTION_SOURCES = [
  'talent_direct',
  'indeed',
  'github',
  'astre_import',
] as const;
export type IngestionSource = (typeof INGESTION_SOURCES)[number];

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
  storage_ref!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, { message: 'sha256 must be 64 lowercase hex chars' })
  sha256!: string;

  @IsString()
  @MaxLength(255)
  content_type!: string;

  @IsISO8601()
  captured_at!: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  verified_email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  profile_url?: string;
}
