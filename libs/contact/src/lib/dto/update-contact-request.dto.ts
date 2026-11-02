import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

// UpdateContactRequestDto — PATCH /v1/contacts/:id payload.
//
// PATCH semantics: omit = unchanged, null = clear (nullable columns only).
// company_id is NOT updatable (a contact belongs to exactly one company).
//
// CONTACTS-1 §7 V-1/V-2 — a validated CLASS (was an interface). Nullable
// columns use @IsOptional (null or omitted skips the format check);
// NON-nullable columns (first_name, last_name, the booleans) use
// @ValidateIf(defined) so an explicit null is refused instead of reaching
// the database.
export class UpdateContactRequestDto {
  @IsOptional()
  @IsUUID()
  company_department_id?: string | null;

  @ValidateIf((o: UpdateContactRequestDto) => o.first_name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  first_name?: string;

  @ValidateIf((o: UpdateContactRequestDto) => o.last_name !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email1?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone_work?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone_cell?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone_other?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  zip?: string | null;

  @ValidateIf((o: UpdateContactRequestDto) => o.is_hot !== undefined)
  @IsBoolean()
  is_hot?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  notes?: string | null;

  @ValidateIf((o: UpdateContactRequestDto) => o.left_company !== undefined)
  @IsBoolean()
  left_company?: boolean;

  // Contacts prototype parity — promote/demote primary. true promotes (and
  // demotes any prior primary for the company, transactional); false demotes.
  @ValidateIf((o: UpdateContactRequestDto) => o.is_primary !== undefined)
  @IsBoolean()
  is_primary?: boolean;

  @IsOptional()
  @IsUUID()
  reports_to_id?: string | null;

  @IsOptional()
  @IsUUID()
  owner_id?: string | null;

  // Contact-spec amendment v1.0 — closed-vocab (validated app-layer via
  // assertContactVocab). PATCH semantics: omit=unchanged, null=clear.
  @IsOptional()
  @IsString()
  relationship_role?: string | null;

  @IsOptional()
  @IsString()
  preference?: string | null;

  // CONTACTS-1 §12 — PERSON | FUNCTIONAL_MAILBOX; null clears.
  @IsOptional()
  @IsString()
  contact_kind?: string | null;
}
