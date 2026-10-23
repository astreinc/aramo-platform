import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

// ATI-SEP-1 A2 A-c (P1) — request DTO for the platform MatchingPolicy surface. Shape
// only: the thresholds document is checked strictly (every role family, integer
// count in bounds, boolean requires_ingested) by @aramo/matching
// parseEvidenceThresholds in the controller.
export class CreateMatchingPolicyVersionDto {
  @IsObject() evidence_thresholds!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
}
