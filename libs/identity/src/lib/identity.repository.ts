import { Injectable } from '@nestjs/common';

import type { ExternalIdentityDto } from './dto/external-identity.dto.js';
import type { UserDto } from './dto/user.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for User / ExternalIdentity reads. Resolve-only: this
// repository never creates a User row at runtime (directive §3
// "Runtime identity flow is resolveUser (resolve-only), never
// resolveOrCreateUser"; §11 halt condition "Implementation needs to
// create a User or ServiceAccount outside the seed path").
@Injectable()
export class IdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Looks up the (provider, provider_subject) pair via the ExternalIdentity
  // unique index, hydrates the linked User. Returns null when no mapping.
  async findUserByExternalIdentity(args: {
    provider: string;
    provider_subject: string;
  }): Promise<UserDto | null> {
    const row = await this.prisma.externalIdentity.findUnique({
      where: {
        provider_provider_subject: {
          provider: args.provider,
          provider_subject: args.provider_subject,
        },
      },
      include: { user: true },
    });
    if (row === null) {
      return null;
    }
    return toUserDto(row.user);
  }

  async findExternalIdentity(args: {
    provider: string;
    provider_subject: string;
  }): Promise<ExternalIdentityDto | null> {
    const row = await this.prisma.externalIdentity.findUnique({
      where: {
        provider_provider_subject: {
          provider: args.provider,
          provider_subject: args.provider_subject,
        },
      },
    });
    if (row === null) {
      return null;
    }
    return toExternalIdentityDto(row);
  }
}

type UserRow = {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  deactivated_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_active: row.is_active,
    deactivated_at: row.deactivated_at !== null ? row.deactivated_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

type ExternalIdentityRow = {
  id: string;
  provider: string;
  provider_subject: string;
  user_id: string;
  email_snapshot: string | null;
  created_at: Date;
  updated_at: Date;
};

function toExternalIdentityDto(row: ExternalIdentityRow): ExternalIdentityDto {
  return {
    id: row.id,
    provider: row.provider,
    provider_subject: row.provider_subject,
    user_id: row.user_id,
    email_snapshot: row.email_snapshot,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
