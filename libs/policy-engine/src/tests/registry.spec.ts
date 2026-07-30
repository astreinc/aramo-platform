import { describe, expect, it } from 'vitest';

import { evaluate } from '../lib/evaluate.js';
import { PolicyEngineError } from '../lib/errors.js';
import { isRegisteredEffectKind, validatePackage } from '../lib/registry.js';
import type { PolicyPackage, Rule } from '../lib/types.js';

import { ctx, pkg } from './_helpers.js';

// ADR §D5 — resource/action registry is a declared, source-resident allowlist.
describe('§D5 registry — a context outside the allowlist is REJECTED', () => {
  it('rejects an unregistered resource', () => {
    const p = pkg([]);
    expect(() => evaluate(p, ctx({ resource: 'NOT_REGISTERED' }))).toThrow(PolicyEngineError);
    try {
      evaluate(p, ctx({ resource: 'NOT_REGISTERED' }));
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('UNREGISTERED_RESOURCE');
    }
  });

  it('rejects an unregistered action', () => {
    const p = pkg([]);
    try {
      evaluate(p, ctx({ action: 'NOT_REGISTERED' }));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('UNREGISTERED_ACTION');
    }
  });
});

describe('§D9 effect registry — the closed set', () => {
  it('recognises every registered effect kind and rejects others', () => {
    for (const k of ['WRITE_AUDIT', 'REQUIRE_REASON', 'NOTIFY_ROLE', 'EMIT_EVENT', 'SHOW_BANNER']) {
      expect(isRegisteredEffectKind(k)).toBe(true);
    }
    expect(isRegisteredEffectKind('DISPATCH_EMAIL')).toBe(false);
  });

  it('validatePackage rejects a rule carrying an unregistered effect kind', () => {
    const bad: Rule = {
      id: 'r1',
      resource: 'DOC',
      action: 'CREATE',
      decision: 'ALLOW_WITH_AUDIT',
      reason_code: 'R',
      effects: [{ kind: 'DISPATCH_EMAIL' as never }],
    };
    try {
      validatePackage(pkg([bad]));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('UNREGISTERED_EFFECT');
    }
  });
});

describe('§D5/§D11 validatePackage — structural invariants', () => {
  it('rejects a rule referencing a resource outside the package allowlist', () => {
    const bad: Rule = { id: 'r', resource: 'GHOST', action: 'CREATE', decision: 'ALLOW', reason_code: 'R' };
    try {
      validatePackage(pkg([bad]));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('UNREGISTERED_RESOURCE');
    }
  });

  it('rejects a REQUIRES_OVERRIDE rule with no required_capability (§D11)', () => {
    const bad: Rule = { id: 'r', resource: 'DOC', action: 'CREATE', decision: 'REQUIRES_OVERRIDE', reason_code: 'R' };
    try {
      validatePackage(pkg([bad]));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('MALFORMED_RULE');
    }
  });

  it('rejects a non-override rule that names a required_capability', () => {
    const bad: Rule = {
      id: 'r',
      resource: 'DOC',
      action: 'CREATE',
      decision: 'ALLOW',
      reason_code: 'R',
      required_capability: 'cap.x',
    };
    try {
      validatePackage(pkg([bad]));
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('MALFORMED_RULE');
    }
  });

  it('R3 — rejects a package that omits default_disposition', () => {
    const noDefault = {
      name: 'p',
      version: 'v1',
      registry: { resources: ['DOC'], actions: ['CREATE'] },
      rules: [],
    } as unknown as PolicyPackage;
    try {
      validatePackage(noDefault);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('MISSING_DEFAULT_DISPOSITION');
    }
  });

  it('R3 — rejects a default_disposition that is REQUIRES_OVERRIDE without a capability', () => {
    const badDefault = pkg([], {
      default_disposition: { decision: 'REQUIRES_OVERRIDE', reason_code: 'X' },
    });
    try {
      validatePackage(badDefault);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as PolicyEngineError).code).toBe('MALFORMED_RULE');
    }
  });

  it('accepts a well-formed package', () => {
    const good: Rule = {
      id: 'r',
      resource: 'DOC',
      action: 'CREATE',
      decision: 'REQUIRES_OVERRIDE',
      reason_code: 'R',
      required_capability: 'cap.x',
      effects: [{ kind: 'WRITE_AUDIT' }],
    };
    expect(() => validatePackage(pkg([good]))).not.toThrow();
  });
});
