import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantService } from '@aramo/identity';

import { IdentityHostContextAdapter } from '../app/auth/identity-host-context.adapter.js';

// Auth-Decoupling PR-5a §4.6 (adapter units, hit + miss) + §4.2 (host null-case
// agreement with extractTenantSlugFromHost) + §4.3 (fail-open by fault injection).

const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';

function make(findActiveBySlug: ReturnType<typeof vi.fn>): {
  adapter: IdentityHostContextAdapter;
  findActiveBySlug: ReturnType<typeof vi.fn>;
} {
  const tenants = { findActiveBySlug } as unknown as TenantService;
  return { adapter: new IdentityHostContextAdapter(tenants), findActiveBySlug };
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env['APP_ROOT_DOMAIN'];
  process.env['APP_ROOT_DOMAIN'] = 'aramo.ai';
});
afterEach(() => {
  if (saved === undefined) delete process.env['APP_ROOT_DOMAIN'];
  else process.env['APP_ROOT_DOMAIN'] = saved;
});

describe('IdentityHostContextAdapter.resolveByHost — hit', () => {
  it('extracts the slug and returns { context_id, identity_provider }', async () => {
    const findActiveBySlug = vi
      .fn()
      .mockResolvedValue({ id: TENANT_ID, identity_provider: 'AstreSAML' });
    const { adapter } = make(findActiveBySlug);
    const ctx = await adapter.resolveByHost('astre.aramo.ai');
    expect(findActiveBySlug).toHaveBeenCalledWith('astre');
    expect(ctx).toEqual({ context_id: TENANT_ID, identity_provider: 'AstreSAML' });
  });

  it('null identity_provider is coerced to null (not undefined)', async () => {
    const { adapter } = make(vi.fn().mockResolvedValue({ id: TENANT_ID, identity_provider: null }));
    const ctx = await adapter.resolveByHost('astre.aramo.ai');
    expect(ctx).toEqual({ context_id: TENANT_ID, identity_provider: null });
  });
});

describe('IdentityHostContextAdapter.resolveByHost — miss (§4.6)', () => {
  it('a slug-shaped host with no active tenant → null', async () => {
    const findActiveBySlug = vi.fn().mockResolvedValue(null);
    const { adapter } = make(findActiveBySlug);
    expect(await adapter.resolveByHost('ghost.aramo.ai')).toBeNull();
    expect(findActiveBySlug).toHaveBeenCalledWith('ghost');
  });
});

describe('§4.2 — reproduces extractTenantSlugFromHost null cases (no tenant read)', () => {
  const NULL_HOSTS: ReadonlyArray<{ label: string; host: string }> = [
    { label: 'empty hostname', host: '' },
    { label: 'not ending in .rootDomain', host: 'evil.com' },
    { label: 'sibling-domain lookalike', host: 'astre.attacker.com' },
    { label: 'bare apex', host: 'aramo.ai' },
    { label: 'multi-label under apex', host: 'a.b.aramo.ai' },
  ];
  for (const { label, host } of NULL_HOSTS) {
    it(`${label} (${JSON.stringify(host)}) → null, findActiveBySlug NOT called`, async () => {
      const findActiveBySlug = vi.fn();
      const { adapter } = make(findActiveBySlug);
      expect(await adapter.resolveByHost(host)).toBeNull();
      expect(findActiveBySlug).not.toHaveBeenCalled();
    });
  }
});

describe('§4.3 — fail-open by fault injection', () => {
  it('findActiveBySlug throws → resolveByHost returns null (never throws)', async () => {
    const { adapter } = make(vi.fn().mockRejectedValue(new Error('db down')));
    await expect(adapter.resolveByHost('astre.aramo.ai')).resolves.toBeNull();
  });
});
