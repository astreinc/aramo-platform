import { IsNotEmpty, IsString } from 'class-validator';

// TR-4 B3 (§3.3) — the resolve-contradiction request body. A human resolves a
// standing contradiction with a REASON (R4 accountability — a resolution is
// high-consequence, never silent). The evidence id is a path param.
export class ResolveContradictionDto {
  @IsString()
  @IsNotEmpty()
  reason!: string;
}
