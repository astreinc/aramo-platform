import { afterEach, describe, expect, it } from 'vitest';

import { CanonicalMatchShadowConfig } from '../examinations/canonical-match-shadow.config.js';

// SKILL-TAX-1E — the shadow flag is DARK by default. Only the exact string "true"
// enables it; absent / "false" / anything else → disabled (zero behavior change).

const ENV = 'SKILL_CANONICAL_SHADOW_ENABLED';

describe('CanonicalMatchShadowConfig — dark by default', () => {
  const saved = process.env[ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('is DISABLED when the env var is absent', () => {
    delete process.env[ENV];
    expect(new CanonicalMatchShadowConfig().isEnabled()).toBe(false);
  });

  it('is DISABLED for "false" and any non-"true" value', () => {
    for (const v of ['false', 'TRUE', '1', 'yes', '']) {
      process.env[ENV] = v;
      expect(new CanonicalMatchShadowConfig().isEnabled()).toBe(false);
    }
  });

  it('is ENABLED only for the exact string "true"', () => {
    process.env[ENV] = 'true';
    expect(new CanonicalMatchShadowConfig().isEnabled()).toBe(true);
  });
});
