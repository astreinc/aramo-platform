import { ReleaseIdentityService } from '@aramo/common';
import { afterEach, describe, expect, it } from 'vitest';

import { VersionController } from '../controllers/version.controller.js';

// GLH-2-A — GET /version output shape + service integration (D-1 class B, runtime
// identity). Pure unit: no Nest harness, no DB. Sets NODE_ENV=production +
// ARAMO_ENV=prod (governed) so a baked valid SHA is returned verbatim.

const SHA = 'a17962f09abf31ea627afbd7232e7dc8953c0f60';

describe('VersionController', () => {
  const saved = {
    rev: process.env['ARAMO_RELEASE_REVISION'],
    node: process.env['NODE_ENV'],
    aramo: process.env['ARAMO_ENV'],
  };
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    restore('ARAMO_RELEASE_REVISION', saved.rev);
    restore('NODE_ENV', saved.node);
    restore('ARAMO_ENV', saved.aramo);
  });

  it('returns { revision } = the baked source revision', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['ARAMO_ENV'] = 'prod';
    process.env['ARAMO_RELEASE_REVISION'] = SHA;
    const controller = new VersionController(new ReleaseIdentityService());
    expect(controller.version()).toEqual({ revision: SHA });
  });

  it('exposes ONLY the revision key — no DB/CI/digest/env leakage', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['ARAMO_ENV'] = 'prod';
    process.env['ARAMO_RELEASE_REVISION'] = SHA;
    const body = new VersionController(new ReleaseIdentityService()).version();
    expect(Object.keys(body)).toEqual(['revision']);
  });
});
