import { describe, expect, it, vi } from 'vitest';

import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import type { UserDto } from '../lib/dto/user.dto.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const COGNITO_SUB = 'fixed-dev-cognito-sub-01';

function makeUserDto(): UserDto {
  return {
    id: USER_ID,
    email: 'admin@aramo.dev',
    display_name: 'Aramo Dev Admin',
    is_active: true,
    deactivated_at: null,
    created_at: '2026-05-12T00:00:00.000Z',
    updated_at: '2026-05-12T00:00:00.000Z',
  };
}

// makePrisma exposes only the slice of the client surface that any
// IdentityService call could legitimately reach via the repo. Tests assert on
// what's called AND what isn't — the .create absence guard depends on the
// shape being complete enough that an unintended .create call would surface
// as a mock-method hit.
function makePrisma(externalIdentityFindUnique: ReturnType<typeof vi.fn>): {
  prisma: PrismaService;
  createSpies: {
    user: ReturnType<typeof vi.fn>;
    externalIdentity: ReturnType<typeof vi.fn>;
    tenant: ReturnType<typeof vi.fn>;
  };
} {
  const userCreate = vi.fn();
  const externalIdentityCreate = vi.fn();
  const tenantCreate = vi.fn();
  const prisma = {
    externalIdentity: { findUnique: externalIdentityFindUnique, create: externalIdentityCreate },
    user: { create: userCreate },
    tenant: { create: tenantCreate },
  } as unknown as PrismaService;
  return {
    prisma,
    createSpies: {
      user: userCreate,
      externalIdentity: externalIdentityCreate,
      tenant: tenantCreate,
    },
  };
}

describe('IdentityService.resolveUser', () => {
  // Test 1: returns User when ExternalIdentity exists.
  it('returns User when ExternalIdentity exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'ei-1',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: 'admin@aramo.dev',
      created_at: new Date(),
      updated_at: new Date(),
      user: {
        id: USER_ID,
        email: 'admin@aramo.dev',
        display_name: 'Aramo Dev Admin',
        is_active: true,
        deactivated_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    const { prisma } = makePrisma(findUnique);
    const service = new IdentityService(new IdentityRepository(prisma));

    const result = await service.resolveUser({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result?.id).toBe(USER_ID);
    expect(result?.email).toBe('admin@aramo.dev');
  });

  // Test 2: returns null when no ExternalIdentity mapping.
  it('returns null when no ExternalIdentity mapping', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const { prisma } = makePrisma(findUnique);
    const service = new IdentityService(new IdentityRepository(prisma));

    const result = await service.resolveUser({
      provider: 'cognito',
      provider_subject: 'unknown-sub',
    });

    expect(result).toBeNull();
  });

  // Test 3: resolveUser does NOT call any .create method (no auto-create).
  it('does NOT call any .create method (no auto-create assertion)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const { prisma, createSpies } = makePrisma(findUnique);
    const service = new IdentityService(new IdentityRepository(prisma));

    await service.resolveUser({ provider: 'cognito', provider_subject: 'never-seen' });

    expect(createSpies.user).not.toHaveBeenCalled();
    expect(createSpies.externalIdentity).not.toHaveBeenCalled();
    expect(createSpies.tenant).not.toHaveBeenCalled();
  });

  // Test 9 (service portion): returns a DTO, not a Prisma model. Verified by
  // shape — ISO-string created_at, no `_count` or relation fields surfaced.
  it('returns a DTO shape (ISO timestamps, no Prisma model fields leaked)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'ei-2',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: 'admin@aramo.dev',
      created_at: new Date('2026-05-12T00:00:00Z'),
      updated_at: new Date('2026-05-12T00:00:00Z'),
      user: {
        id: USER_ID,
        email: 'admin@aramo.dev',
        display_name: 'Aramo Dev Admin',
        is_active: true,
        deactivated_at: null,
        created_at: new Date('2026-05-12T00:00:00Z'),
        updated_at: new Date('2026-05-12T00:00:00Z'),
      },
    });
    const { prisma } = makePrisma(findUnique);
    const service = new IdentityService(new IdentityRepository(prisma));

    const result = (await service.resolveUser({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    })) satisfies UserDto | null;

    expect(result).not.toBeNull();
    if (result === null) return;
    // ISO string, not Date
    expect(typeof result.created_at).toBe('string');
    expect(typeof result.updated_at).toBe('string');
    // No `_count` or relation fields
    expect(result).not.toHaveProperty('memberships');
    expect(result).not.toHaveProperty('external_identities');
    expect(result).toEqual(makeUserDto());
  });
});
