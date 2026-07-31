import { describe, expect, it } from 'vitest';

import { scopesToCapabilities } from '../lib/policy/capability-adapter.js';

// §D10 capability adapter — scopes[] -> Record<string, boolean>.

describe('scopesToCapabilities', () => {
  it('maps each granted scope to true', () => {
    expect(scopesToCapabilities(['pipeline:add', 'pipeline:read'])).toEqual({
      'pipeline:add': true,
      'pipeline:read': true,
    });
  });

  it('returns an empty map for the empty scope set', () => {
    expect(scopesToCapabilities([])).toEqual({});
  });

  it('is idempotent over duplicate scopes', () => {
    expect(scopesToCapabilities(['x', 'x'])).toEqual({ x: true });
  });
});
