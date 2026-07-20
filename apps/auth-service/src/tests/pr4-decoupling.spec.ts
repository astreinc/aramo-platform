import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Auth-Decoupling PR-4 §3.4 — THE ACCEPTANCE TEST. Proves the three re-pointed
// files import NONE of IdentityService / TenantService / RoleService /
// IdentityAuditService from @aramo/identity — the whole point of the PR. Comments
// are stripped first (the docstrings legitimately name the removed services to
// explain the decoupling, so a raw substring check would false-fail).
// host-base-resolver + host-auth-profile MAY still import @aramo/identity — that
// is PR-5's (a different port shape). This spec does not touch them.

const FILES = [
  'session-orchestrator.service.ts',
  'refresh-orchestrator.service.ts',
  'auth.controller.ts',
];

const FORBIDDEN = [
  'IdentityService',
  'TenantService',
  'RoleService',
  'IdentityAuditService',
];

function codeWithoutComments(basename: string): string {
  const path = resolve(__dirname, '../app/auth', basename);
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block + JSDoc comments
    .replace(/\/\/[^\n]*/g, ''); // line comments
}

describe('§3.4 — the session/refresh/logout surface is decoupled from @aramo/identity', () => {
  for (const file of FILES) {
    describe(file, () => {
      const code = codeWithoutComments(file);

      it('does NOT import from @aramo/identity', () => {
        expect(code).not.toContain('@aramo/identity');
      });

      for (const svc of FORBIDDEN) {
        it(`does NOT reference ${svc}`, () => {
          expect(code).not.toContain(svc);
        });
      }
    });
  }

  it('DOES depend on the auth-owned ports instead', () => {
    const session = codeWithoutComments('session-orchestrator.service.ts');
    expect(session).toContain('./principal-directory.port');
    expect(session).toContain('./audit-sink.port');
    const refresh = codeWithoutComments('refresh-orchestrator.service.ts');
    expect(refresh).toContain('./principal-directory.port');
    expect(refresh).toContain('./audit-sink.port');
    const controller = codeWithoutComments('auth.controller.ts');
    expect(controller).toContain('./audit-sink.port');
  });
});
