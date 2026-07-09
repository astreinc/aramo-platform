import { describe, expect, it } from 'vitest';

import {
  normalizeSlug,
  deriveSlugOrThrow,
  extractTenantSlugFromHost,
} from '../lib/util/tenant-slug.js';

// Subdomain-Identity Directive A — the subdomain-slug primitives. Proves the
// single-source provision gate (deriveSlugOrThrow) accepts only DNS-safe labels
// and the host extractor is anchored to the apex (so the cert-eligibility ask-
// endpoint can never vouch for `<slug>.attacker.com`).
describe('tenant-slug — normalizeSlug', () => {
  it('trims + lowercases to the canonical form', () => {
    expect(normalizeSlug('  Astre  ')).toBe('astre');
    expect(normalizeSlug('MyCo')).toBe('myco');
  });
});

describe('tenant-slug — deriveSlugOrThrow (single-source provision gate)', () => {
  it('returns the normalized DNS-safe label', () => {
    expect(deriveSlugOrThrow('Astre', 'rq')).toBe('astre');
    expect(deriveSlugOrThrow('acme-corp', 'rq')).toBe('acme-corp');
    expect(deriveSlugOrThrow('a1', 'rq')).toBe('a1');
    // single-char labels are allowed
    expect(deriveSlugOrThrow('x', 'rq')).toBe('x');
  });

  // Platform-Console Increment-2 PR-1 (workstream F) — reserved slugs.
  it('refuses reserved/platform slugs with reason reserved_slug', () => {
    for (const reserved of [
      'admin', 'www', 'api', 'auth', 'app', 'platform',
      'support', 'status', 'mail', 'docs', 'assets', 'ADMIN', ' Admin ',
    ]) {
      expect(() => deriveSlugOrThrow(reserved, 'rq')).toThrowError(
        expect.objectContaining({
          code: 'VALIDATION_ERROR',
          context: expect.objectContaining({
            details: expect.objectContaining({ reason: 'reserved_slug' }),
          }),
        }),
      );
    }
  });

  it('a normal tenant slug that merely contains a reserved word is allowed', () => {
    // only the EXACT label is reserved — 'admin-corp' / 'wwwx' are fine.
    expect(deriveSlugOrThrow('admin-corp', 'rq')).toBe('admin-corp');
    expect(deriveSlugOrThrow('acme', 'rq')).toBe('acme');
  });

  it('throws invalid_slug for an empty / whitespace-only slug', () => {
    for (const bad of ['', '   ']) {
      expect(() => deriveSlugOrThrow(bad, 'rq')).toThrowError(
        expect.objectContaining({
          code: 'VALIDATION_ERROR',
          context: expect.objectContaining({
            details: expect.objectContaining({ reason: 'invalid_slug' }),
          }),
        }),
      );
    }
  });

  it('throws invalid_slug for non-DNS-safe charset / shape', () => {
    // underscore, leading/trailing hyphen, dot, space, uppercase-after-trim-none
    for (const bad of ['bad_slug', '-lead', 'trail-', 'a.b', 'has space', 'över']) {
      expect(() => deriveSlugOrThrow(bad, 'rq')).toThrowError(
        expect.objectContaining({
          context: expect.objectContaining({
            details: expect.objectContaining({ reason: 'invalid_slug' }),
          }),
        }),
      );
    }
  });

  it('throws invalid_slug for a label longer than 63 chars (DNS ceiling)', () => {
    expect(() => deriveSlugOrThrow('a'.repeat(64), 'rq')).toThrowError(
      expect.objectContaining({
        context: expect.objectContaining({
          details: expect.objectContaining({ reason: 'invalid_slug' }),
        }),
      }),
    );
    // exactly 63 is fine
    expect(deriveSlugOrThrow('a'.repeat(63), 'rq')).toBe('a'.repeat(63));
  });
});

describe('tenant-slug — extractTenantSlugFromHost (apex-anchored)', () => {
  const ROOT = 'aramo.ai';

  it('extracts the single label under the apex', () => {
    expect(extractTenantSlugFromHost('astre.aramo.ai', ROOT)).toBe('astre');
    expect(extractTenantSlugFromHost('tentest.aramo.ai', ROOT)).toBe('tentest');
    // case-insensitive + strips a port
    expect(extractTenantSlugFromHost('Astre.Aramo.AI:443', ROOT)).toBe('astre');
  });

  it('returns null for the bare apex (no subdomain label)', () => {
    expect(extractTenantSlugFromHost('aramo.ai', ROOT)).toBeNull();
  });

  it('returns null for a multi-label host (only one label under apex allowed)', () => {
    expect(extractTenantSlugFromHost('a.b.aramo.ai', ROOT)).toBeNull();
  });

  it('returns null for a foreign domain — the SSRF anchor (cannot vouch for <slug>.attacker.com)', () => {
    expect(extractTenantSlugFromHost('astre.attacker.com', ROOT)).toBeNull();
    expect(extractTenantSlugFromHost('aramo.ai.attacker.com', ROOT)).toBeNull();
    expect(extractTenantSlugFromHost('evil.com', ROOT)).toBeNull();
  });

  it('returns null for empty / malformed host', () => {
    expect(extractTenantSlugFromHost('', ROOT)).toBeNull();
    expect(extractTenantSlugFromHost('localhost', ROOT)).toBeNull();
  });
});
