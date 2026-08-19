import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

// T2-E1-HF2 test J — the canonical default tenant capability bundle has a SINGLE
// entitlement-owned source. The platform provisioning saga must consume
// DEFAULT_TENANT_CAPABILITIES from @aramo/entitlement and must NOT maintain its
// own private capability bundle literal. Grep-style guard (directive §18 J).
const SERVICE = resolve(
  __dirname,
  '../app/platform/platform-invitation.service.ts',
);

describe('default capability bundle — single entitlement-owned source', () => {
  const src = readFileSync(SERVICE, 'utf8');

  it('imports DEFAULT_TENANT_CAPABILITIES from @aramo/entitlement', () => {
    expect(src).toMatch(/DEFAULT_TENANT_CAPABILITIES/);
    expect(src).toMatch(/from '@aramo\/entitlement'/);
  });

  it('does not declare a private capability bundle copy', () => {
    // No private `DEFAULT_CAPABILITIES: ... = [...]` declaration.
    expect(src).not.toMatch(/DEFAULT_CAPABILITIES\s*:/);
    // No hand-typed [core, ats, portal] literal (the bundle lives in the lib).
    expect(src).not.toMatch(/\[\s*'core'\s*,\s*'ats'\s*,\s*'portal'\s*\]/);
  });
});
