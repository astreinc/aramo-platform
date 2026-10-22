import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

// Sign Personal (Free) Launch v1.1 (LOCKED) §6.5 / §10 — operator action DTOs (the
// 400-shape gate; PersonalRiskService / PersonalSignupRepository are the authority).

export class PersonalRiskActionRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  // restrict only: an end time for the restriction; omitted = until an operator reinstates.
  @IsOptional()
  @IsISO8601()
  until?: string;
}

export class IssuePersonalInviteRequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

// §6.4 — the operator's outcome for one abuse report. FALSE_REPORT lowers the
// reporter's future weight; CONFIRMED / DISMISSED close it. A person decides.
export class DecideAbuseReportRequestDto {
  @IsIn(['CONFIRMED', 'FALSE_REPORT', 'DISMISSED'])
  outcome!: 'CONFIRMED' | 'FALSE_REPORT' | 'DISMISSED';

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
