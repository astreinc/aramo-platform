import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

// TR-12 B1/B2 — request DTOs for the caseworker's dismiss + mark-acted endpoints.
// The global ValidationPipe runs whitelist + forbidNonWhitelisted, so these
// classes (not interfaces) gate the body shape: unknown props are rejected.

const JUSTIFICATION_MAX = 2000;

// POST /v1/talent/identity/proposals/:id/dismiss — justification is REQUIRED (a
// dismissal is a reviewer's judgment that a proposal is not worth acting on; it
// is never silent). A missing/empty justification is a shape failure → the pipe's
// VALIDATION_ERROR 400 (distinct from the OPEN-only guard's PROPOSAL_NOT_OPEN 409).
export class DismissProposalRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(JUSTIFICATION_MAX)
  justification!: string;
}

// POST /v1/talent/identity/proposals/:id/act (TR-12 B2 §3.1) — bookkeeping only.
// The human already invoked the real action through its own gated endpoint; this
// records that they did. An OPTIONAL note (the actor is the JWT sub). Executes
// nothing.
export class MarkActedRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  note?: string;
}
