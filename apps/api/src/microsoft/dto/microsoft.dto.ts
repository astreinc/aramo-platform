import {
  IsEmail,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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

  @IsUUID()
  requisition_id!: string;

  @IsOptional()
  @IsUUID()
  pipeline_id?: string;

  @IsOptional()
  @IsUUID()
  connection_id?: string;

  @IsEmail()
  to_email!: string;

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
