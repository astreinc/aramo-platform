import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EnterpriseSearchController } from '../search/enterprise-search.controller.js';
import type { EnterpriseSearchPort, SearchResults } from '../search/enterprise-search.port.js';

// GS-1 — the HTTP seam: the controller resolves visibility via the interceptor, transports it
// as already-resolved authority, parses entity_types/limit, and delegates to the port. No
// authority is computed here. (Per-entity scope gating + visibility filtering are proven in
// the orchestrator unit spec and the adapter/e2e integration specs.)

const RESULTS: SearchResults = { query: 'java', groups: [] };
const visibility = {
  actor_user_id: 'u-1',
  see_all_company: true,
  see_all_requisition: true,
  visible_client_ids: null,
};
const authContext = { tenant_id: 'T', scopes: ['talent:search', 'company:search'] } as never;

function makeReq(): { resolveVisibility: ReturnType<typeof vi.fn> } {
  return { resolveVisibility: vi.fn(async () => visibility) };
}

describe('EnterpriseSearchController (GS-1 HTTP seam)', () => {
  let search: ReturnType<typeof vi.fn>;
  let controller: EnterpriseSearchController;

  beforeEach(() => {
    search = vi.fn(async () => RESULTS);
    controller = new EnterpriseSearchController({ search } as unknown as EnterpriseSearchPort);
  });

  it('resolves visibility and passes it as authority; parses entity_types + limit', async () => {
    const req = makeReq();
    const res = await controller.searchAll(authContext, 'java', 'TALENT,COMPANY', '5', 'req-1', req as never);
    expect(req.resolveVisibility).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({
      query: 'java',
      entity_types: ['TALENT', 'COMPANY'],
      authority: { tenant_id: 'T', scopes: ['talent:search', 'company:search'], visibility },
      limit_per_type: 5,
      requestId: 'req-1',
    });
    expect(res).toBe(RESULTS);
  });

  it('absent entity_types = global (undefined); unknown types are dropped', async () => {
    await controller.searchAll(authContext, 'x', undefined, undefined, 'r', makeReq() as never);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ entity_types: undefined, limit_per_type: undefined }),
    );
    search.mockClear();
    await controller.searchAll(authContext, 'x', 'BOGUS,talent', undefined, 'r', makeReq() as never);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ entity_types: ['TALENT'] }));
  });

  it('defaults a missing query to empty string', async () => {
    await controller.searchAll(authContext, undefined, undefined, undefined, 'r', makeReq() as never);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });
});
