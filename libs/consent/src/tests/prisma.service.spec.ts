import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';

// M3 PR-17 / F21 — lazy first-use validation contract for libs/consent.
// Confirms:
//   (a) construction succeeds when DATABASE_URL is absent (no constructor
//       throw — the eager-validation hazard is gone);
//   (b) the same 'DATABASE_URL is not configured' error is raised on
//       first DB access (here, `$connect()`) if DATABASE_URL is still
//       absent — i.e. the validation has moved, not vanished.
describe('PrismaService (consent) — lazy DATABASE_URL validation', () => {
  let savedDatabaseUrl: string | undefined;

  beforeEach(() => {
    savedDatabaseUrl = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
  });

  afterEach(() => {
    if (savedDatabaseUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = savedDatabaseUrl;
    }
  });

  it('constructs successfully when DATABASE_URL is absent (no constructor throw)', () => {
    expect(() => new PrismaService()).not.toThrow();
  });

  it("throws 'DATABASE_URL is not configured' on first DB access ($connect) if still absent", async () => {
    const service = new PrismaService();
    await expect(service.$connect()).rejects.toThrow('DATABASE_URL is not configured');
  });
});
