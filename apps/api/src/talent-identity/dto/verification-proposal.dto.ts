import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { LIFECYCLE_TEXT_MAX, PROPOSAL_ACTIONS, type ProposalAction } from '@aramo/intelligence-contracts';

// TR-12 B1/B2 → ATI-SEP-1 T10 WP3b — request DTOs for the caseworker's dismiss +
// mark-acted endpoints (relayed to Talent Intelligence). The global
// ValidationPipe runs whitelist + forbidNonWhitelisted, so these classes gate
// the body shape: unknown props are rejected.

// POST /v1/talent/identity/proposals/:id/dismiss — justification is REQUIRED (a
// dismissal is a reviewer's judgment; it is never silent).
export class DismissProposalRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(LIFECYCLE_TEXT_MAX)
  justification!: string;
}

// POST /v1/talent/identity/proposals/:id/act — bookkeeping only. `action` names
// what the human did through the real gated endpoint (defaults from the
// proposal kind); an OPTIONAL note. The actor is the JWT sub. Executes nothing.
export class MarkActedRequestDto {
  @IsOptional()
  @IsIn(PROPOSAL_ACTIONS)
  action?: ProposalAction;

  @IsOptional()
  @IsString()
  @MaxLength(LIFECYCLE_TEXT_MAX)
  note?: string;
}
