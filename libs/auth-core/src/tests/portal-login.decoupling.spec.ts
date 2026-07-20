import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Auth-Decoupling PR-2/3 §3.4 — THE ACCEPTANCE TEST. Proves portal-login.service.ts
// no longer imports @aramo/mailer, @aramo/identity-index, or computeEmailFingerprint.
// Without this, the PR could pass while leaving the coupling in place. Comments are
// stripped first — the class docstring legitimately NAMES the removed deps to
// explain the decoupling, so a raw substring check would false-fail.

const SERVICE_SRC = resolve(__dirname, '../lib/portal-login.service.ts');

function codeWithoutComments(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // block + JSDoc comments
    .replace(/\/\/[^\n]*/g, ''); // line comments
}

describe('§3.4 — portal-login.service.ts is decoupled from the Aramo deps', () => {
  const code = codeWithoutComments(SERVICE_SRC);

  it('does NOT import @aramo/mailer', () => {
    expect(code).not.toContain('@aramo/mailer');
    expect(code).not.toContain('MAILER_PORT');
    expect(code).not.toContain('MailerPort');
  });

  it('does NOT import @aramo/identity-index', () => {
    expect(code).not.toContain('@aramo/identity-index');
    expect(code).not.toContain('IdentityIndexRepository');
  });

  it('does NOT import or call computeEmailFingerprint (auth stops computing fingerprints)', () => {
    expect(code).not.toContain('computeEmailFingerprint');
  });

  it('DOES depend on the auth-owned ports instead', () => {
    expect(code).toContain('./email-sender.port');
    expect(code).toContain('./eligibility-policy.port');
    expect(code).toContain('EMAIL_SENDER');
    expect(code).toContain('ELIGIBILITY_POLICY');
  });

  it('still imports normalizeEmail from @aramo/common (R-P23-6 — it stays)', () => {
    expect(code).toContain('normalizeEmail');
    expect(code).toContain('@aramo/common');
  });
});
