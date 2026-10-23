import { describe, expect, it } from 'vitest';

import {
  IntelligenceDatabaseConfigError,
  IntelligencePrismaService,
  resolveIntelligenceDatabaseUrl,
} from '../index.js';

// ATI-SEP-1 T0 — TI reads ONLY INTELLIGENCE_DATABASE_URL and fails closed.

const TI_URL = 'postgresql://aramo_intelligence:pw@postgres:5432/aramo_intelligence';
const ATS_URL = 'postgresql://aramo:pw@postgres:5432/aramo?schema=public';

describe('resolveIntelligenceDatabaseUrl', () => {
  it('returns INTELLIGENCE_DATABASE_URL when set', () => {
    expect(resolveIntelligenceDatabaseUrl({ INTELLIGENCE_DATABASE_URL: TI_URL, DATABASE_URL: ATS_URL })).toBe(TI_URL);
  });

  it('fails closed when unset or blank — never falls back to DATABASE_URL', () => {
    expect(() => resolveIntelligenceDatabaseUrl({ DATABASE_URL: ATS_URL })).toThrow(IntelligenceDatabaseConfigError);
    expect(() => resolveIntelligenceDatabaseUrl({ INTELLIGENCE_DATABASE_URL: '   ' })).toThrow(
      /INTELLIGENCE_DATABASE_URL is not configured/,
    );
  });

  it('refuses the shared Aramo database URL', () => {
    expect(() => resolveIntelligenceDatabaseUrl({ INTELLIGENCE_DATABASE_URL: ATS_URL, DATABASE_URL: ATS_URL })).toThrow(
      /must not use the shared Aramo database/,
    );
  });
});

describe('IntelligencePrismaService construction', () => {
  it('throws at construction when INTELLIGENCE_DATABASE_URL is unset (boot fails loud)', () => {
    const saved = process.env['INTELLIGENCE_DATABASE_URL'];
    delete process.env['INTELLIGENCE_DATABASE_URL'];
    try {
      expect(() => new IntelligencePrismaService()).toThrow(IntelligenceDatabaseConfigError);
    } finally {
      if (saved !== undefined) process.env['INTELLIGENCE_DATABASE_URL'] = saved;
    }
  });

  it('constructs without connecting when given an explicit URL', () => {
    expect(() => new IntelligencePrismaService(TI_URL)).not.toThrow();
  });
});
