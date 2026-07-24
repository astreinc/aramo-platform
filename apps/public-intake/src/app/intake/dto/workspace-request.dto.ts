import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// POST /intake/workspace-request — name, work email, firm all required; message
// optional. Length caps per §1.3: 200 / 254 / 200 / 4000. `website` is the
// hidden honeypot (real users never fill it; a non-empty value is silently
// dropped by the controller).
export class WorkspaceRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  firm!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  message?: string;

  @IsOptional()
  @IsString()
  website?: string;
}
