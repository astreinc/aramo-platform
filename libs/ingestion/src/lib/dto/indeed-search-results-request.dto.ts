import {
  ArrayMaxSize,
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

// POST /v1/ingestion/indeed/search-results request body. Per API
// Contracts v1.0 Phase 4 Group 3 Step 1 (PR-13 directive §4.1).
//
// The wire body carries NO contact data — Phase 4 Step 1 explicitly
// states "No contact data extracted". The recruiter (or
// tenant-approved governed automation) ran the Indeed search
// externally; this endpoint receives the resulting shortlist record.
//
// The source is fixed to "indeed" server-side (the endpoint path
// implies it); the request body does not include a source field.
// tenant_id is NOT a request field — resolved from authContext at
// the service boundary (libs/consent precedent carried forward).
export class IndeedSearchResultsRequestDto {
  @IsUUID()
  talent_id!: string;

  @IsString()
  @MaxLength(2048)
  storage_ref!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i, {
    message: 'sha256 must be 64 lowercase hex chars',
  })
  sha256!: string;

  @IsString()
  @MaxLength(255)
  content_type!: string;

  @IsISO8601()
  captured_at!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  source_record_id?: string;

  // Optional raw skill surface forms — opaque strings, no
  // canonicalization to Skills Taxonomy (Plan §3 M2 Track A: "raw
  // forms stored, canonicalization deferred").
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  skill_surface_forms?: string[];
}
