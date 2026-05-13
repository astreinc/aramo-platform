import { describe, expect, it, vi } from 'vitest';

import type { RefreshTokenDto } from '../lib/dto/refresh-token.dto.js';
import type { RefreshTokenRepository } from '../lib/refresh-token.repository.js';
import { RefreshTokenService } from '../lib/refresh-token.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';

function makeDto(overrides: Partial<RefreshTokenDto> = {}): RefreshTokenDto {
  return {
    id: '01900000-0000-7000-8000-0000000000bb',
    user_id: USER_ID,
    tenant_id: '01900000-0000-7000-8000-0000000000aa',
    consumer_type: 'recruiter',
    token_hash: 'h',
    created_at: '2026-05-12T00:00:00.000Z',
    updated_at: '2026-05-12T00:00:00.000Z',
    expires_at: '2026-06-11T00:00:00.000Z',
    revoked_at: null,
    replaced_by_id: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<RefreshTokenRepository> = {}): RefreshTokenRepository {
  return {
    create: vi.fn(),
    findByHash: vi.fn(),
    rotate: vi.fn(),
    revoke: vi.fn(),
    revokeAllForUser: vi.fn(),
    ...overrides,
  } as unknown as RefreshTokenRepository;
}

describe('RefreshTokenService.detectReuse', () => {
  // Test 14: returns false when replaced_by_id is null.
  it('returns false when replaced_by_id is null', async () => {
    const service = new RefreshTokenService(makeRepo());
    const result = await service.detectReuse({
      token: makeDto({ replaced_by_id: null }),
      grace_seconds: 30,
    });
    expect(result).toBe(false);
  });

  // Test 15: returns false when within grace window.
  it('returns false when revoked_at within grace window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:00:30.000Z'));
    const service = new RefreshTokenService(makeRepo());
    const result = await service.detectReuse({
      token: makeDto({
        revoked_at: '2026-05-12T00:00:15.000Z',
        replaced_by_id: 'new-id',
      }),
      grace_seconds: 30,
    });
    expect(result).toBe(false);
    vi.useRealTimers();
  });

  // Test 16: returns true when past grace AND replaced_by_id is set.
  it('returns true when past grace window and replaced_by_id is set', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T00:01:00.000Z'));
    const service = new RefreshTokenService(makeRepo());
    const result = await service.detectReuse({
      token: makeDto({
        revoked_at: '2026-05-12T00:00:00.000Z',
        replaced_by_id: 'new-id',
      }),
      grace_seconds: 30,
    });
    expect(result).toBe(true);
    vi.useRealTimers();
  });
});

describe('RefreshTokenService delegations', () => {
  // Confirms the service is a thin pass-through to the repository.
  it('create delegates to repo.create', async () => {
    const create = vi.fn().mockResolvedValue(makeDto());
    const service = new RefreshTokenService(makeRepo({ create }));
    await service.create({
      user_id: USER_ID,
      tenant_id: '01900000-0000-7000-8000-0000000000aa',
      consumer_type: 'recruiter',
      token_hash: 'h',
      expires_at: new Date(),
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('findByHash delegates', async () => {
    const findByHash = vi.fn().mockResolvedValue(null);
    const service = new RefreshTokenService(makeRepo({ findByHash }));
    await service.findByHash({ token_hash: 'h' });
    expect(findByHash).toHaveBeenCalledWith({ token_hash: 'h' });
  });

  it('rotate delegates', async () => {
    const rotate = vi
      .fn()
      .mockResolvedValue({ new_token: makeDto(), old_token: makeDto() });
    const service = new RefreshTokenService(makeRepo({ rotate }));
    await service.rotate({
      old_id: 'x',
      new_token_hash: 'h2',
      new_expires_at: new Date(),
    });
    expect(rotate).toHaveBeenCalledTimes(1);
  });

  it('revoke delegates', async () => {
    const revoke = vi.fn().mockResolvedValue(makeDto());
    const service = new RefreshTokenService(makeRepo({ revoke }));
    await service.revoke({ id: 'x' });
    expect(revoke).toHaveBeenCalledWith({ id: 'x' });
  });

  it('revokeAllForUser delegates', async () => {
    const revokeAllForUser = vi.fn().mockResolvedValue({ revoked_count: 2 });
    const service = new RefreshTokenService(makeRepo({ revokeAllForUser }));
    const r = await service.revokeAllForUser({ user_id: USER_ID });
    expect(r.revoked_count).toBe(2);
  });
});
