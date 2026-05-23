import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';

// F21 standing contract — lazy PrismaService pattern.
//
// The submittal PrismaService is the tenth model-bearing PrismaService
// in the workspace. The F21 contract (codified in post-PR-17 cleanup):
//   1. Inert constructor — never reads env, never throws.
//   2. Lazy first-use validation at $connect() time with the byte-
//      identical error string 'DATABASE_URL is not configured'.
//
// Mirrors libs/evidence/src/tests/prisma.service.spec.ts.

describe('PrismaService (submittal) — F21 lazy contract', () => {
  let savedDbUrl: string | undefined;

  beforeEach(() => {
    savedDbUrl = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
  });

  afterEach(() => {
    if (savedDbUrl === undefined) {
      delete process.env['DATABASE_URL'];
    } else {
      process.env['DATABASE_URL'] = savedDbUrl;
    }
  });

  it('constructs inert (no env read; does not throw on instantiation)', () => {
    expect(() => new PrismaService()).not.toThrow();
  });

  it('throws "DATABASE_URL is not configured" on first $connect() when env is absent', async () => {
    const svc = new PrismaService();
    await expect(svc.$connect()).rejects.toThrow('DATABASE_URL is not configured');
  });
});
