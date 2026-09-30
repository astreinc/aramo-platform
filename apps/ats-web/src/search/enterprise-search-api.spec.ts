import { afterEach, describe, expect, it, vi } from 'vitest';

import { enterpriseSearch } from './enterprise-search-api';

// Enterprise Search GS-1 — the single search client builds exactly one /v1/search request.

const ok = () =>
  new Response(JSON.stringify({ query: '', groups: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('enterpriseSearch client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds /v1/search?q=', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await enterpriseSearch('ada');
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('/v1/search?q=ada');
    expect(url).not.toContain('entity_types=');
    expect(url).not.toContain('limit=');
  });

  it('encodes entity_types (comma) and limit for module-scoped search', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await enterpriseSearch('java dev', { entityTypes: ['TALENT', 'COMPANY'], limit: 5 });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('q=java+dev');
    expect(url).toContain('entity_types=TALENT%2CCOMPANY');
    expect(url).toContain('limit=5');
  });

  it('omits entity_types when the list is empty (global search)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await enterpriseSearch('x', { entityTypes: [] });
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('entity_types=');
  });
});
