import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { zoneFor } from './zones';

describe('Sign S-2 — authentication zones of the one Sign application', () => {
  it.each([
    ['/s/abc', '', 'guest-sign'],
    ['/s/abc/', '?x=1', 'guest-sign'],
    ['/d/abc', '', 'guest-download'],
    ['/', '?token=abc', 'guest-sign'],
    ['/', '', 'workspace'],
    ['/sign/envelopes', '', 'workspace'],
    ['/personal', '', 'workspace'],
    ['/login', '?error=X', 'workspace'],
    ['/signup', '', 'workspace'],
    ['/sign', '?token=abc', 'workspace'],
    ['/settings', '', 'workspace'],
  ] as const)('%s%s → %s', (path, search, zone) => {
    expect(zoneFor(path, search)).toBe(zone);
  });

  // The guest zone must never import the session/auth library or workspace code:
  // a guest page makes no session call and carries no workspace credentials.
  it('guest code imports neither @aramo/fe-foundation nor the workspace', () => {
    const dir = resolve(__dirname, 'guest');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && !/\.spec\./.test(n)) files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from ['"]@aramo\//);
      expect(src, f).not.toMatch(/from ['"]\.\.\/workspace/);
    }
  });

  it('every guest API call omits credentials', () => {
    const src = readFileSync(resolve(__dirname, 'guest/sign-api.ts'), 'utf8');
    const calls = [...src.matchAll(/fetch\(/g)].length;
    expect(calls).toBeGreaterThan(0);
    expect([...src.matchAll(/^\s+credentials: 'omit',$/gm)].length).toBe(calls);
  });
});
