import { Icons } from '../ui';

// Field provenance — REAL signal only, and HONEST about the extractor (LOCKED:
// Add-Talent Governed-LLM Resume Extraction §16). MODE IS EXCLUSIVE, so a
// prefilled field came from exactly one extractor:
//   - 'governed_llm':  the governed LLM proposed it (résumé), recruiter unchanged.
//   - 'deterministic': the deterministic parser proposed it (résumé), unchanged.
//   - 'edited':        it came from the résumé and the recruiter has changed it.
// Fields the recruiter types from scratch carry no chip. This is FE-local draft
// metadata only — no persisted/public enum, no migration (§16). The mockup's
// low-confidence "needs review" chip stays DROPPED (no confidence signal).
export type Provenance = 'governed_llm' | 'deterministic' | 'edited';

export type ProvenanceMap = Partial<Record<string, Provenance>>;

// A field is résumé-sourced (from either extractor) and not yet edited.
export function isResumeSourced(prov?: Provenance): boolean {
  return prov === 'governed_llm' || prov === 'deterministic';
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
  if (prov === 'deterministic') {
    return (
      <span className="rc-prov rc-prov--resume">
        <Icons.IconFile />
        resume
      </span>
    );
  }
  if (prov === 'edited') {
    return <span className="rc-prov rc-prov--edited">edited</span>;
  }
  return null;
}
