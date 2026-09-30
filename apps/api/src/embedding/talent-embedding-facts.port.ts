import type { TalentSemanticFacts } from './talent-semantic-document.js';

// Enterprise Search GS-2 P5 — the seam that loads the authoritative, PII-minimized recruiting facts
// for a Talent subject (composing TalentRecord + authoritative TalentWorkHistoryEntry). Returns null
// when the Talent is NOT a live embeddable subject (superseded / erased / not found) — the lifecycle
// treats null as an invalidation signal. The concrete composer lands in GS-2A; the P3 projection
// (buildTalentSemanticDocument) turns these facts into the deterministic semantic document.
//
// STRING token per the non-strict-lookup collision rule.
export const TALENT_EMBEDDING_FACTS_PORT = 'TALENT_EMBEDDING_FACTS_PORT';

export interface TalentEmbeddingFactsPort {
  load(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<TalentSemanticFacts | null>;
}
