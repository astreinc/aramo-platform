import { IsString, Length } from 'class-validator';

// Portal P4 P4b (§PR-2, D-3) — the RTBF request/result envelopes. The grave
// type-to-confirm: `confirmation` is the caller's own email re-typed (server
// compares it, normalized, to the session identity's email). Tenant-facing? No —
// this is the talent acting on their OWN platform identity.

export class PortalRtbfRequestDto {
  // The caller re-types their own email address to confirm (D-3 grave confirm).
  @IsString()
  @Length(1, 320)
  confirmation!: string;
}

export interface PortalRtbfResultDto {
  // Terminal: the platform identity is erased and the session destroyed.
  erased: boolean;
}
