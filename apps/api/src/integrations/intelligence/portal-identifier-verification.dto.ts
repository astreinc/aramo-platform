import { IsIn, IsString, Matches } from 'class-validator';

// ATI-SEP-1 T8 — portal identifier verification (Talent Intelligence path).
// The caller names a STORED slot, never an address (the address is read off the
// record).
export class RequestIdentifierVerificationDto {
  @IsIn(['email1', 'email2'])
  slot!: 'email1' | 'email2';
}

export class ConfirmIdentifierVerificationDto {
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
