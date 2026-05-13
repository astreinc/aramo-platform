import { describe, expect, it, vi } from 'vitest';

import { JwksController } from '../app/auth/jwks.controller.js';
import type { JwksService } from '../app/auth/jwks.service.js';

describe('JwksController.getJwks', () => {
  it('delegates to JwksService.getJwks and returns the JWKS document', async () => {
    const doc = {
      keys: [
        { kty: 'RSA' as const, use: 'sig' as const, alg: 'RS256' as const, kid: 'k', n: 'n', e: 'e' },
      ],
    };
    const svc = { getJwks: vi.fn().mockResolvedValue(doc) } as unknown as JwksService;
    const ctl = new JwksController(svc);
    const result = await ctl.getJwks({} as never);
    expect(result).toEqual(doc);
    expect(svc.getJwks).toHaveBeenCalledTimes(1);
  });
});
