// Enterprise Search GS-2A — the read seam for semantic Talent retrieval. The GS-1 Talent search
// adapter (apps/api) depends on this port; the concrete repository runs the visibility-co-located
// cosine query in SQL (never global top-k then filter). STRING token per the collision rule.
export const TALENT_EMBEDDING_SEARCH_PORT = 'TALENT_EMBEDDING_SEARCH_PORT';

/** One semantic match — the Talent id + its cosine distance (0 = identical; smaller = closer). */
export interface TalentSemanticMatch {
  readonly talent_record_id: string;
  readonly distance: number;
}

export interface TalentEmbeddingSearchPort {
  /**
   * Nearest ready embeddings to `query_vector` for this actor's pool-open visibility (tenant +,
   * when present, site). The tenant/site predicate is co-located INSIDE the vector SQL — the query
   * never ranks then filters. Returns at most `limit` matches ordered by ascending distance.
   */
  searchSemanticForActor(input: {
    tenant_id: string;
    site_id: string | null;
    query_vector: readonly number[];
    limit: number;
  }): Promise<TalentSemanticMatch[]>;
}
