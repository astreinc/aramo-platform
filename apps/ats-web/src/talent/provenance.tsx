import { Icons } from '../ui';

// Field provenance — REAL signal only, and HONEST about the extractor (§16).
// Governed LLM is the SOLE résumé fact extractor (TI-1F P0.2), so a prefilled
// field came from the governed LLM:
//   - 'governed_llm':  the governed LLM proposed it (résumé), recruiter unchanged.
//   - 'edited':        it came from the résumé and the recruiter has changed it.
// Fields the recruiter types from scratch carry no chip. This is FE-local draft
// metadata only — no persisted/public enum, no migration (§16). The mockup's
// low-confidence "needs review" chip stays DROPPED (no confidence signal).
export type Provenance = 'governed_llm' | 'edited';

export type ProvenanceMap = Partial<Record<string, Provenance>>;

// A field is résumé-sourced (governed LLM) and not yet edited.
export function isResumeSourced(prov?: Provenance): boolean {
  return prov === 'governed_llm';
}

export function ProvenanceChip({ prov }: { readonly prov?: Provenance }) {
  if (prov === 'governed_llm') {
    return (
      <span className="rc-prov rc-prov--resume">
        <Icons.IconFile />
        resume · AI
      </span>
    );
  }
  if (prov === 'edited') {
    return <span className="rc-prov rc-prov--edited">edited</span>;
  }
  return null;
}
