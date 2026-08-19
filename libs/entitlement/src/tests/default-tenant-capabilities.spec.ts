import { describe, it, expect } from 'vitest';

import {
  CAPABILITY_VALUES,
  DEFAULT_TENANT_CAPABILITIES,
  isCapability,
} from '../lib/capability.js';

// T2-E1-HF2 tests A/B/J — the canonical default tenant capability bundle is the
// single authoritative source and is exactly {core, ats, portal} with sourcing
// excluded.
describe('DEFAULT_TENANT_CAPABILITIES — canonical default bundle', () => {
  it('is exactly [core, ats, portal] (order-independent)', () => {
    expect([...DEFAULT_TENANT_CAPABILITIES].sort()).toEqual(
      ['ats', 'core', 'portal'].sort(),
    );
    expect(DEFAULT_TENANT_CAPABILITIES).toHaveLength(3);
  });

  it('excludes sourcing', () => {
    expect(DEFAULT_TENANT_CAPABILITIES).not.toContain('sourcing');
  });

  it('contains only valid capability keys that are a subset of the catalog', () => {
    for (const c of DEFAULT_TENANT_CAPABILITIES) {
      expect(isCapability(c)).toBe(true);
      expect(CAPABILITY_VALUES).toContain(c);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(DEFAULT_TENANT_CAPABILITIES).size).toBe(
      DEFAULT_TENANT_CAPABILITIES.length,
    );
  });
});
