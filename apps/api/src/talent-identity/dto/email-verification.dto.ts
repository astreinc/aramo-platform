import { IsIn } from 'class-validator';

// TR-3 B2 (§3.1, acceptance (c)) — the verification-request body.
//
// STORED-SLOT-ONLY, BY CONSTRUCTION. The caller names WHICH stored address on
// the record to verify — `email1` or `email2` — and NOTHING else. There is no
// `email`/`address`/`to` field: a caller-supplied recipient is STRUCTURALLY
// impossible. The service reads the actual address from the record's slot, so
// the verification link can only ever be mailed to an address the record
// already holds. This is the anti-oracle at the request boundary: a recruiter
// cannot use the endpoint to mail an attacker-chosen address.
//
// (@IsIn on a two-value closed set — the ValidationPipe rejects any other slot
// name with 400 VALIDATION_ERROR before the service runs.)

export const VERIFIABLE_EMAIL_SLOTS = ['email1', 'email2'] as const;
export type VerifiableEmailSlot = (typeof VERIFIABLE_EMAIL_SLOTS)[number];

export class RequestEmailVerificationDto {
  @IsIn(VERIFIABLE_EMAIL_SLOTS)
  slot!: VerifiableEmailSlot;
}
