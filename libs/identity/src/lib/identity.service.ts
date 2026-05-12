import { Injectable } from '@nestjs/common';

import type { UserDto } from './dto/user.dto.js';
import { IdentityRepository } from './identity.repository.js';

// IdentityService — resolve-only. Per directive §7 + §3: returns null when no
// ExternalIdentity mapping exists; auth flow fails safely. Never creates a User.
@Injectable()
export class IdentityService {
  constructor(private readonly identityRepo: IdentityRepository) {}

  async resolveUser(args: {
    provider: string;
    provider_subject: string;
  }): Promise<UserDto | null> {
    return this.identityRepo.findUserByExternalIdentity(args);
  }
}
