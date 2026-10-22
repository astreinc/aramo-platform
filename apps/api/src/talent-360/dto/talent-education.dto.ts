import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

// ATS-QA-1 I-4 (L2) — the recruiter education entry body, for add and for
// correction alike (a correction sends the full corrected entry). Fields mirror
// TalentEducationEntry. Certifications are separate and not accepted here.
// tenant, Talent and actor come ONLY from the JWT and the path.

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
// An empty optional value is "not stated" (null), never an empty string.
const trimOrNull = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? null : t;
};

export class TalentEducationEntryRequestDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  institution_name!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  degree_name!: string;

  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(300)
  field_of_study?: string | null;

  // A calendar date (YYYY-MM-DD). Omitted or empty = not stated. A partial date is
  // refused rather than completed with a guessed month or day.
  @IsOptional()
  @Transform(trimOrNull)
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'conferred_date must be a calendar date (YYYY-MM-DD)',
  })
  conferred_date?: string | null;
}
