import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EnterpriseSearchReadService,
  SEARCH_DEFAULT_LIMIT_PER_TYPE,
  SEARCH_MAX_LIMIT_PER_TYPE,
} from '../search/enterprise-search-read.service.js';
import type { SearchEntityAdapter } from '../search/search-entity-adapter.js';
import type {
  SearchAuthorityContext,
  SearchEntityType,
  SearchHit,
} from '../search/enterprise-search.port.js';

// GS-1 unit proof of the orchestrator's cross-cutting policy — scope gating, fan-out,
// exact-first ordering, bounded limits, honest unauthorized/empty groups. No DB: adapters
// are fakes, so this asserts the ORCHESTRATION contract in isolation (per-domain retrieval
// is proven separately by each adapter's integration spec).

function hit(entity_type: SearchEntityType, id: string, signal: 'exact' | 'lexical', relevance: number): SearchHit {
  return {
    entity_type,
    entity_id: id,
    display_label: `${entity_type}-${id}`,
    subtitle: null,
    snippet: null,
    route: `/${entity_type.toLowerCase()}/${id}`,
    match: { signal, relevance },
  };
}

function fakeAdapter(
  entity_type: SearchEntityType,
  required_scope: string,
  returns: SearchHit[] = [],
): SearchEntityAdapter & { search: ReturnType<typeof vi.fn> } {
  return {
    entity_type,
    required_scope,
    search: vi.fn(async () => returns),
  };
}

function authority(scopes: string[]): SearchAuthorityContext {
  return {
    tenant_id: 't-1',
    scopes,
    visibility: {
      actor_user_id: 'u-1',
      see_all_company: true,
      see_all_requisition: true,
      visible_client_ids: null,
    },
  };
}

describe('EnterpriseSearchReadService (GS-1 orchestration)', () => {
  let talent: ReturnType<typeof fakeAdapter>;
  let company: ReturnType<typeof fakeAdapter>;
  let requisition: ReturnType<typeof fakeAdapter>;

  beforeEach(() => {
    talent = fakeAdapter('TALENT', 'talent:search', [hit('TALENT', 'a', 'lexical', 0.5)]);
    company = fakeAdapter('COMPANY', 'company:search', [hit('COMPANY', 'c', 'lexical', 0.5)]);
    requisition = fakeAdapter('REQUISITION', 'requisition:search', [hit('REQUISITION', 'r', 'lexical', 0.5)]);
  });

  it('does NOT call an adapter when the actor lacks its :search scope, and marks the requested group unauthorized', async () => {
    const svc = new EnterpriseSearchReadService([talent]);
    const results = await svc.search({
      query: 'java',
      entity_types: ['TALENT'],
      authority: authority([]), // no talent:search
      requestId: 'req-1',
    });
    expect(talent.search).not.toHaveBeenCalled();
    const group = results.groups.find((g) => g.entity_type === 'TALENT');
    expect(group).toBeDefined();
    expect(group?.unauthorized).toBe(true);
    expect(group?.hits).toEqual([]);
  });

  it('calls the adapter and returns its hits when the actor holds the scope', async () => {
    const svc = new EnterpriseSearchReadService([talent]);
    const results = await svc.search({
      query: 'java',
      entity_types: ['TALENT'],
      authority: authority(['talent:search']),
      requestId: 'req-1',
    });
    expect(talent.search).toHaveBeenCalledTimes(1);
    const group = results.groups.find((g) => g.entity_type === 'TALENT');
    expect(group?.unauthorized).toBeFalsy();
    expect(group?.hits.map((h) => h.entity_id)).toEqual(['a']);
  });

  it('global search (no entity_types) searches only authorized types and OMITS unauthorized ones', async () => {
    const svc = new EnterpriseSearchReadService([talent, company, requisition]);
    const results = await svc.search({
      query: 'java',
      authority: authority(['talent:search', 'company:search']), // NOT requisition:search
      requestId: 'req-1',
    });
    expect(talent.search).toHaveBeenCalledTimes(1);
    expect(company.search).toHaveBeenCalledTimes(1);
    expect(requisition.search).not.toHaveBeenCalled();
    const types = results.groups.map((g) => g.entity_type).sort();
    expect(types).toEqual(['COMPANY', 'TALENT']);
    // global search never reveals the existence of an unauthorized type
    expect(results.groups.some((g) => g.entity_type === 'REQUISITION')).toBe(false);
  });

  it('orders each group exact-first, then by relevance desc', async () => {
    const mixed = fakeAdapter('TALENT', 'talent:search', [
      hit('TALENT', 'lex-hi', 'lexical', 0.9),
      hit('TALENT', 'exact-lo', 'exact', 0.1),
      hit('TALENT', 'lex-lo', 'lexical', 0.2),
      hit('TALENT', 'exact-hi', 'exact', 0.8),
    ]);
    const svc = new EnterpriseSearchReadService([mixed]);
    const results = await svc.search({
      query: 'x',
      entity_types: ['TALENT'],
      authority: authority(['talent:search']),
      requestId: 'req-1',
    });
    const order = results.groups[0]?.hits.map((h) => h.entity_id);
    // exact tier first (exact-hi then exact-lo), then lexical (lex-hi then lex-lo)
    expect(order).toEqual(['exact-hi', 'exact-lo', 'lex-hi', 'lex-lo']);
  });

  it('bounds the per-type limit to the hard cap and applies the default when unset', async () => {
    const svc = new EnterpriseSearchReadService([talent]);
    await svc.search({
      query: 'java',
      entity_types: ['TALENT'],
      authority: authority(['talent:search']),
      limit_per_type: 9999,
      requestId: 'req-1',
    });
    expect(talent.search).toHaveBeenCalledWith('java', expect.anything(), SEARCH_MAX_LIMIT_PER_TYPE);

    talent.search.mockClear();
    await svc.search({
      query: 'java',
      entity_types: ['TALENT'],
      authority: authority(['talent:search']),
      requestId: 'req-1',
    });
    expect(talent.search).toHaveBeenCalledWith('java', expect.anything(), SEARCH_DEFAULT_LIMIT_PER_TYPE);
  });

  it('short-circuits a blank query: no adapter calls, empty groups', async () => {
    const svc = new EnterpriseSearchReadService([talent, company]);
    const results = await svc.search({
      query: '   ',
      authority: authority(['talent:search', 'company:search']),
      requestId: 'req-1',
    });
    expect(talent.search).not.toHaveBeenCalled();
    expect(company.search).not.toHaveBeenCalled();
    expect(results.groups).toEqual([]);
  });
});
