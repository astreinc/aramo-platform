import { describe, expect, it, vi } from 'vitest';
import { EmbeddingUnavailableError, type EmbeddingPort } from '@aramo/ai-draft';
import type { TalentRecordRepository, TalentRecordView } from '@aramo/talent-record';
import type { TalentEmbeddingSearchPort, TalentSemanticMatch } from '@aramo/talent-embedding';

import { TalentSearchAdapter } from '../search/adapters/talent-search.adapter.js';
import { EmbeddingProcessingConfig } from '../embedding/embedding-processing.config.js';
import type { SearchAuthorityContext } from '../search/enterprise-search.port.js';

// GS-2A — the Talent adapter's semantic leg. Proves the fail-soft + dark-gate invariants WITHOUT a
// DB: the semantic leg never regresses exact/lexical, the three-band signal precedence holds on
// dedupe, and hydration drops non-live rows.

function row(id: string, first: string, last: string, extra: Partial<TalentRecordView> = {}): TalentRecordView {
  return {
    id,
    first_name: first,
    last_name: last,
    city: null,
    state: null,
    title: null,
    current_employer: null,
    key_skills: null,
    record_status: 'live',
    ...extra,
  } as TalentRecordView;
}

function makeRepo(opts: {
  name?: TalentRecordView[];
  resume?: TalentRecordView[];
  exact?: TalentRecordView[];
  byId?: Record<string, TalentRecordView | null>;
}): TalentRecordRepository {
  return {
    searchByExactEmail: vi.fn(async () => opts.exact ?? []),
    list: vi.fn(async () => opts.name ?? []),
    searchByResumeText: vi.fn(async () => opts.resume ?? []),
    findById: vi.fn(async ({ id }: { id: string }) => opts.byId?.[id] ?? null),
  } as unknown as TalentRecordRepository;
}

function makeEmbedding(embedErr?: Error): EmbeddingPort {
  return {
    embed: vi.fn(async () => {
      if (embedErr) throw embedErr;
      return { vector: [0.1, 0.2, 0.3], provider: 'openai', model: 'text-embedding-3-small', dimension: 1536 };
    }),
  } as unknown as EmbeddingPort;
}

function makeSemantic(matches: TalentSemanticMatch[]): TalentEmbeddingSearchPort {
  return { searchSemanticForActor: vi.fn(async () => matches) } as unknown as TalentEmbeddingSearchPort;
}

function config(enabled: boolean): EmbeddingProcessingConfig {
  return { isEnabled: () => enabled } as unknown as EmbeddingProcessingConfig;
}

const AUTH: SearchAuthorityContext = {
  tenant_id: 't-1',
  site_id: 's-1',
  scopes: ['talent:search'],
  visibility: { actor_user_id: 'u-1', see_all_company: true, see_all_requisition: true, visible_client_ids: null },
};

describe('TalentSearchAdapter — GS-2A semantic leg', () => {
  it('dark flag OFF: never embeds, returns only exact/lexical hits', async () => {
    const repo = makeRepo({ name: [row('a', 'Ada', 'Lovelace')] });
    const embedding = makeEmbedding();
    const adapter = new TalentSearchAdapter(repo, embedding, makeSemantic([]), config(false));

    const hits = await adapter.search('ada', AUTH, 10);
    expect(hits.map((h) => h.entity_id)).toEqual(['a']);
    expect(hits[0]?.match.signal).toBe('lexical');
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('FAIL-SOFT: flag ON but embedding throws EmbeddingUnavailableError → byte-equivalent to GS-1', async () => {
    const build = (enabled: boolean, embedErr?: Error): TalentSearchAdapter =>
      new TalentSearchAdapter(
        makeRepo({ name: [row('a', 'Ada', 'Lovelace')], resume: [row('b', 'Bob', 'Nguyen', { resume_snippet: 'go' } as Partial<TalentRecordView>)] }),
        makeEmbedding(embedErr),
        makeSemantic([{ talent_record_id: 'z', distance: 0.01 }]),
        config(enabled),
      );

    const gs1 = await build(false).search('engineer', AUTH, 10);
    const failSoft = await build(true, new EmbeddingUnavailableError('no tenant key')).search('engineer', AUTH, 10);
    // Exact/lexical results + ordering are byte-identical when the semantic leg is unavailable.
    expect(failSoft).toEqual(gs1);
    expect(failSoft.some((h) => h.match.signal === 'semantic')).toBe(false);
  });

  it('FAIL-SOFT: flag ON but embedding throws a transient error → still byte-equivalent to GS-1', async () => {
    const build = (enabled: boolean, embedErr?: Error): TalentSearchAdapter =>
      new TalentSearchAdapter(
        makeRepo({ name: [row('a', 'Ada', 'Lovelace')] }),
        makeEmbedding(embedErr),
        makeSemantic([{ talent_record_id: 'z', distance: 0.01 }]),
        config(enabled),
      );
    const gs1 = await build(false).search('engineer', AUTH, 10);
    const failSoft = await build(true, new Error('upstream 503')).search('engineer', AUTH, 10);
    expect(failSoft).toEqual(gs1);
  });

  it('flag ON + semantic matches: adds a semantic-signal hit for a new record', async () => {
    const repo = makeRepo({
      name: [row('a', 'Ada', 'Lovelace')],
      byId: { z: row('z', 'Zoe', 'Vector') },
    });
    const adapter = new TalentSearchAdapter(repo, makeEmbedding(), makeSemantic([{ talent_record_id: 'z', distance: 0.2 }]), config(true));

    const hits = await adapter.search('platform engineer', AUTH, 10);
    const z = hits.find((h) => h.entity_id === 'z');
    expect(z?.match.signal).toBe('semantic');
    expect(z?.match.relevance).toBeCloseTo(0.8, 5); // 1 - distance
    expect(hits.find((h) => h.entity_id === 'a')?.match.signal).toBe('lexical');
  });

  it('signal precedence: a record matched by lexical AND semantic stays lexical (one hit)', async () => {
    const repo = makeRepo({
      name: [row('a', 'Ada', 'Lovelace')],
      byId: { a: row('a', 'Ada', 'Lovelace') },
    });
    const adapter = new TalentSearchAdapter(repo, makeEmbedding(), makeSemantic([{ talent_record_id: 'a', distance: 0.05 }]), config(true));

    const hits = await adapter.search('ada', AUTH, 10);
    expect(hits.filter((h) => h.entity_id === 'a')).toHaveLength(1);
    expect(hits.find((h) => h.entity_id === 'a')?.match.signal).toBe('lexical');
  });

  it('hydration drops a semantic match whose record is missing or not live', async () => {
    const repo = makeRepo({
      byId: { gone: null, superseded: row('superseded', 'Old', 'Husk', { record_status: 'superseded' } as Partial<TalentRecordView>) },
    });
    const adapter = new TalentSearchAdapter(
      repo,
      makeEmbedding(),
      makeSemantic([{ talent_record_id: 'gone', distance: 0.1 }, { talent_record_id: 'superseded', distance: 0.1 }]),
      config(true),
    );
    const hits = await adapter.search('anything', AUTH, 10);
    expect(hits).toHaveLength(0);
  });
});
