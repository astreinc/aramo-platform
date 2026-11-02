import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// CreateContactRequestDto — POST /v1/contacts payload.
//
// tenant_id is derived from AuthContext.tenant_id, not the body.
// company_id is REQUIRED (every contact belongs to a company).
//
// CONTACTS-1 §7 V-1/V-2 — a validated CLASS (was a decorator-free interface)
// so the global ValidationPipe (whitelist + forbidNonWhitelisted + transform)
// bounds this route: email + UUID format and string lengths. The closed
// vocabularies (relationship_role / preference / contact_kind) stay on the
// app-layer assertContactVocab guard so their VALIDATION_ERROR shape is
// unchanged. Cross-row references (reports_to_id, company_department_id,
// owner_id) are checked in-tenant by the repository (V-3).
export class CreateContactRequestDto {
  @IsUUID()
  company_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  first_name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  last_name!: string;

  @IsOptional()
  @IsUUID()
  site_id?: string;

  @IsOptional()
  @IsUUID()
  company_department_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email1?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone_work?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone_cell?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone_other?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  zip?: string;

  @IsOptional()
  @IsBoolean()
  is_hot?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  notes?: string;

  // Contacts prototype parity — mark this contact primary for its company.
  // Promote demotes any prior primary (repo, transactional). Default false.
  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;

  @IsOptional()
  @IsUUID()
  reports_to_id?: string;

  @IsOptional()
  @IsUUID()
  owner_id?: string;

  // Contact-spec amendment v1.0 — closed-vocab (validated app-layer via
  // assertContactVocab; see contact-vocab.ts). Optional; omitted = unclassified.
  @IsOptional()
  @IsString()
  relationship_role?: string;

  @IsOptional()
  @IsString()
  preference?: string;

  // CONTACTS-1 §12 — PERSON | FUNCTIONAL_MAILBOX (assertContactVocab).
  @IsOptional()
  @IsString()
  contact_kind?: string;
}
