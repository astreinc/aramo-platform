import { describe, expect, it, vi } from 'vitest';

import { IdentityRepository } from '../lib/identity.repository.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000002';
const COGNITO_SUB = 'fixed-dev-cognito-sub-01';

function makePrisma(externalIdentityFindUnique: ReturnType<typeof vi.fn>): PrismaService {
  return {
    externalIdentity: { findUnique: externalIdentityFindUnique },
  } as unknown as PrismaService;
}

describe('IdentityRepository.findUserByExternalIdentity', () => {
  it('returns a UserDto when ExternalIdentity exists (test 1 supporting)', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000004',
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
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findUserByExternalIdentity({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(USER_ID);
    expect(result?.email).toBe('admin@aramo.dev');
    expect(result?.is_active).toBe(true);
    expect(result?.deactivated_at).toBeNull();
    // Created_at serializes as ISO string at the public boundary.
    expect(typeof result?.created_at).toBe('string');
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        provider_provider_subject: {
          provider: 'cognito',
          provider_subject: COGNITO_SUB,
        },
      },
      include: { user: true },
    });
  });

  it('returns null when no ExternalIdentity mapping exists (test 2 supporting)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findUserByExternalIdentity({
      provider: 'cognito',
      provider_subject: 'unknown-sub',
    });

    expect(result).toBeNull();
  });

  it('serializes deactivated_at when User.deactivated_at is set', async () => {
    const deactivatedAt = new Date('2026-05-10T00:00:00Z');
    const findUnique = vi.fn().mockResolvedValue({
      id: 'ext-id',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: null,
      created_at: new Date(),
      updated_at: new Date(),
      user: {
        id: USER_ID,
        email: 'inactive@aramo.dev',
        display_name: null,
        is_active: false,
        deactivated_at: deactivatedAt,
        created_at: new Date(),
        updated_at: new Date(),
      },
    });
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findUserByExternalIdentity({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result?.is_active).toBe(false);
    expect(result?.deactivated_at).toBe(deactivatedAt.toISOString());
  });
});

describe('IdentityRepository.findExternalIdentity', () => {
  it('returns ExternalIdentityDto when mapping exists', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: '01900000-0000-7000-8000-000000000004',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: 'admin@aramo.dev',
      created_at: new Date('2026-05-12T00:00:00Z'),
      updated_at: new Date('2026-05-12T00:00:00Z'),
    });
    const repo = new IdentityRepository(makePrisma(findUnique));

    const result = await repo.findExternalIdentity({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });

    expect(result?.user_id).toBe(USER_ID);
    expect(result?.provider).toBe('cognito');
    expect(typeof result?.created_at).toBe('string');
  });
});
