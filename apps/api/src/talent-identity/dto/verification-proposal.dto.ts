import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// TR-12 B1 — request DTO for the caseworker's dismiss endpoint. The global
// ValidationPipe runs whitelist + forbidNonWhitelisted, so this class (not an
// interface) gates the body shape: unknown props are rejected.

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
