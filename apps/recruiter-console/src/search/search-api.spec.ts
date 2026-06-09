import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  searchCompanies,
  searchContacts,
  searchRequisitions,
  searchTalent,
} from './search-api';

// Search FE /search — the ?q= URL construction (consuming the PR#221
// per-entity primitive). Each fn appends a URL-encoded q to the entity's
// LIST path.

function mockOk() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('search-api — ?q= URL construction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('targets the 4 PR#221 endpoints with an encoded q', async () => {
    const spy = mockOk();
    await searchTalent('jane');
    await searchCompanies('acme');
    await searchRequisitions('engineer');
    await searchContacts('a b'); // space → encoded
    const paths = spy.mock.calls.map((c) => String(c[0]));
    expect(paths[0]).toBe('/v1/talent-records?q=jane');
    expect(paths[1]).toBe('/v1/companies?q=acme');
    expect(paths[2]).toBe('/v1/requisitions?q=engineer');
    // URLSearchParams encodes the space (as + per application/x-www-form-urlencoded).
    expect(paths[3]).toBe('/v1/contacts?q=a+b');
  });
});
