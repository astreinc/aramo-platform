import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// COMM-C2B — request DTOs for recruiter Microsoft execution. Provider-neutral at
// the API surface (no Microsoft-specific fields); the recruiter identity comes
// from the JWT, not the body.

// COMM PART B — tenant-admin establishment of the Microsoft connection. Non-secret
// confidential-client config (client_id + authority_tenant) plus an OPTIONAL
// client_secret. The secret is accepted ONCE, written write-only to Secrets
// Manager, and NEVER returned/echoed. Omitting it on update keeps the stored one.
export class ConfigureMicrosoftConnectionRequestDto {
  @IsString() @MinLength(1) @MaxLength(200) client_id!: string;
  @IsString() @MinLength(1) @MaxLength(200) authority_tenant!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(512) client_secret?: string;
}

export class SendMicrosoftEmailRequestDto {
  @IsUUID()
  talent_record_id!: string;

  // COMM-RECRUITER-W1 (W1-A2) — OPTIONAL. A General Talent Contact send carries NO
  // requisition. When PRESENT, COMM-C4 behavior is preserved exactly (requisition
  // REGARDING association + governed no_contact→contacted orchestration). This is
  // an additive relaxation of the application contract; Communications already
  // defines requisition context as optional at the data layer.
  @IsOptional()
  @IsUUID()
  requisition_id?: string;

  @IsOptional()
  @IsUUID()
  pipeline_id?: string;

  @IsOptional()
  @IsUUID()
  connection_id?: string;

  // COMM-C4 — NO client-supplied recipient. The address is resolved server-side
  // from the Talent record; the send contract carries no `to_email`.

  @IsString()
  @MinLength(1)
  @MaxLength(998)
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  body!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotency_key!: string;

  // D-EMAIL-TPL-1 (ET-8) — DESCRIPTIVE template provenance of the reviewed draft,
  // relayed from the server-authored draft response. NOT authoritative: the server
  // records it as metadata and NEVER uses it for authorization, template lookup, or
  // to change the sent content (subject/body above remain the truth). template_id
  // is a plain string (the code-default value is a sentinel, not a row UUID).
  @IsOptional()
  @IsString()
  @MaxLength(120)
  template_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  template_id?: string;
}

export class CreateMicrosoftMeetingRequestDto {
  @IsUUID()
  talent_record_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsOptional()
  @IsUUID()
  pipeline_id?: string;

  @IsOptional()
  @IsUUID()
  connection_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  subject!: string;

  @IsISO8601()
  start_date_time!: string;

  @IsISO8601()
  end_date_time!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotency_key!: string;
}

// COMM-C2B Amendment A1 (M365-SCHED-1) — Outlook calendar scheduling (SEPARATE from
// create-link-only). The recruiter is the organizer (from the JWT, never the body);
// the Talent is the attendee (resolved server-side). No union-typed arrays, so the
// global forbidNonWhitelisted pipe stays satisfied.
export class CreateMicrosoftCalendarMeetingRequestDto {
  @IsUUID()
  talent_record_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsOptional()
  @IsUUID()
  pipeline_id?: string;

  @IsOptional()
  @IsUUID()
  connection_id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  subject!: string;

  @IsISO8601()
  start_date_time!: string;

  @IsISO8601()
  end_date_time!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  time_zone!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotency_key!: string;
}

export class RescheduleMicrosoftCalendarMeetingRequestDto {
  @IsOptional()
  @IsUUID()
  connection_id?: string;

  // Optimistic-concurrency guard (CAS). The caller echoes the version it last read;
  // a stale value loses the race with 409 MICROSOFT_MEETING_VERSION_CONFLICT.
  @IsInt()
  @Min(0)
  expected_version!: number;

  @IsISO8601()
  start_date_time!: string;

  @IsISO8601()
  end_date_time!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  time_zone!: string;
}

export class CancelMicrosoftCalendarMeetingRequestDto {
  @IsOptional()
  @IsUUID()
  connection_id?: string;

  @IsInt()
  @Min(0)
  expected_version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
