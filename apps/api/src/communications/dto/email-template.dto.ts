import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// D-EMAIL-TPL-1 (ET-4) — reusable email-template management DTOs. Plain-text V1
// (D-2): subject ≤ 998 / body ≤ 100000 (mirrors the recruiter-send DTO). Category
// is a closed enum; template_key is DERIVED server-side (the browser never picks a
// key). Merge-token validation is enforced in the service (closed allowlist).

const EMAIL_TEMPLATE_CATEGORIES = ['requisition_initial_contact', 'talent_general_contact'] as const;

export class CreateEmailTemplateRequestDto {
  @IsIn(EMAIL_TEMPLATE_CATEGORIES)
  category!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(998)
  subject_template!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  body_template!: string;
}

export class UpdateEmailTemplateRequestDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(998)
  subject_template?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  body_template?: string;
}

export class PreviewEmailTemplateRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(998)
  subject_template!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100000)
  body_template!: string;
}
