import { describe, expect, it } from 'vitest';

import { AramoError } from '../lib/errors/index.js';
import {
  isGovernedRuntime,
  LOCAL_REVISION_SENTINEL,
  resolveReleaseRevision,
} from '../lib/util/release-identity.js';

// GLH-2-A (GLH-2 Release Integrity) — release-identity validation + fail-closed
// governed behavior. Pure functions take an explicit env object, so no
// process.env mutation is needed. D-1 classes C (invalid revision), F (local
// sentinel), and the governed/local discriminator are proven here.

const SHA = 'a17962f09abf31ea627afbd7232e7dc8953c0f60'; // 40-char lowercase
const GOVERNED = { NODE_ENV: 'production', ARAMO_ENV: 'prod' } as NodeJS.ProcessEnv;
const LOCAL_DOCKER = { NODE_ENV: 'production', ARAMO_ENV: 'local' } as NodeJS.ProcessEnv;
const LOCAL_DEV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('isGovernedRuntime', () => {
  it('production + prod-like ARAMO_ENV ⇒ governed', () => {
    expect(isGovernedRuntime({ NODE_ENV: 'production', ARAMO_ENV: 'prod' })).toBe(true);
    expect(isGovernedRuntime({ NODE_ENV: 'production', ARAMO_ENV: 'staging' })).toBe(true);
  });
  it('production + UNSET ARAMO_ENV ⇒ governed (fail-closed on ambiguity)', () => {
    expect(isGovernedRuntime({ NODE_ENV: 'production' })).toBe(true);
  });
  it('production + explicit local ARAMO_ENV ⇒ NOT governed (local docker stack)', () => {
    expect(isGovernedRuntime({ NODE_ENV: 'production', ARAMO_ENV: 'local' })).toBe(false);
  });
  it('non-production NODE_ENV ⇒ NOT governed (local dev process)', () => {
    expect(isGovernedRuntime({ NODE_ENV: 'development' })).toBe(false);
    expect(isGovernedRuntime({})).toBe(false);
  });
});

describe('resolveReleaseRevision — valid revision always wins', () => {
  it('returns the exact 40-char lowercase SHA in a governed runtime', () => {
    expect(resolveReleaseRevision({ ...GOVERNED, ARAMO_RELEASE_REVISION: SHA })).toBe(SHA);
  });
  it('returns the SHA even in a local runtime', () => {
    expect(resolveReleaseRevision({ ...LOCAL_DEV, ARAMO_RELEASE_REVISION: SHA })).toBe(SHA);
  });
  it('trims surrounding whitespace before validating', () => {
    expect(resolveReleaseRevision({ ...GOVERNED, ARAMO_RELEASE_REVISION: `  ${SHA}\n` })).toBe(SHA);
  });
});

describe('resolveReleaseRevision — governed runtime fails closed (D-1 class C)', () => {
  const expectThrow = (env: NodeJS.ProcessEnv, kind: 'env_missing' | 'env_invalid'): void => {
    let err: unknown;
    try {
      resolveReleaseRevision(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AramoError);
    expect((err as AramoError).context?.details).toMatchObject({
      kind,
      name: 'ARAMO_RELEASE_REVISION',
    });
  };

  it('missing revision ⇒ env_missing', () => expectThrow({ ...GOVERNED }, 'env_missing'));
  it('empty revision ⇒ env_missing', () =>
    expectThrow({ ...GOVERNED, ARAMO_RELEASE_REVISION: '' }, 'env_missing'));
  it('abbreviated/short SHA ⇒ env_invalid', () =>
    expectThrow({ ...GOVERNED, ARAMO_RELEASE_REVISION: 'a17962f' }, 'env_invalid'));
  it('UPPERCASE SHA ⇒ env_invalid (non-lowercase rejected)', () =>
    expectThrow({ ...GOVERNED, ARAMO_RELEASE_REVISION: SHA.toUpperCase() }, 'env_invalid'));
  it('the ARG default "unknown" ⇒ env_invalid', () =>
    expectThrow({ ...GOVERNED, ARAMO_RELEASE_REVISION: 'unknown' }, 'env_invalid'));
  it('the literal "dev" sentinel is rejected in a governed runtime ⇒ env_invalid', () =>
    expectThrow({ ...GOVERNED, ARAMO_RELEASE_REVISION: 'dev' }, 'env_invalid'));
});

describe('resolveReleaseRevision — local runtime uses the dev sentinel (D-1 class F)', () => {
  it('local dev process (non-production) + no revision ⇒ dev', () => {
    expect(resolveReleaseRevision({ ...LOCAL_DEV })).toBe(LOCAL_REVISION_SENTINEL);
  });
  it('local docker stack (production + ARAMO_ENV=local) + unknown revision ⇒ dev', () => {
    expect(resolveReleaseRevision({ ...LOCAL_DOCKER, ARAMO_RELEASE_REVISION: 'unknown' })).toBe(
      LOCAL_REVISION_SENTINEL,
    );
  });
});
