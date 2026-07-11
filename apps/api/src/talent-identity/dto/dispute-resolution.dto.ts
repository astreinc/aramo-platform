import { IsNotEmpty, IsString } from 'class-validator';

// TR-15 B1 (DDR §2) — the dispute request bodies, built to the
// ResolveContradictionDto convention: lenient (presence + string only) so the
// SERVICE is the domain gate, not the DTO. The evidence id is a path param.

// Raise a dispute against a VALID evidence record. `grounds` is the recorded
// reason (R4 accountability — a dispute is high-consequence, never silent).
export class RaiseDisputeDto {
  @IsString()
  @IsNotEmpty()
  grounds!: string;
}

// Resolve a standing dispute. `outcome` is deliberately a lenient string (NOT an
// enum at the DTO): the service validates 'upheld' | 'rejected' and emits
// DISPUTE_OUTCOME_INVALID (422) for anything else. `justification` records the
// resolver's reasoning on both outcomes.
export class ResolveDisputeDto {
  @IsString()
  @IsNotEmpty()
  outcome!: string;

  @IsString()
  @IsNotEmpty()
  justification!: string;
}
