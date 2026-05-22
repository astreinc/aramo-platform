import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';

// M4 PR-1 §4.6 — F21 verification surface for libs/evidence (the ninth
// model-bearing PrismaService in the workspace). Confirms the post-PR-17
// uniform lazy-validation contract:
//   (a) construction succeeds when DATABASE_URL is absent (no constructor
//       throw — the eager-validation hazard PR-17 removed must stay
//       removed in this new lib);
//   (b) the same byte-identical 'DATABASE_URL is not configured' error
//       is raised on first DB access (here, `$connect()`) if DATABASE_URL
//       is still absent — i.e. the validation has moved, not vanished.
//
// Hermetic env save/restore in beforeEach/afterEach so this spec does
// not leak DATABASE_URL state to sibling tests.
describe('PrismaService (evidence) — lazy DATABASE_URL validation', () => {
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
