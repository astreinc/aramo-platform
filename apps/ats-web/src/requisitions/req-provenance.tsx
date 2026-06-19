import { Icons } from '../ui';

// New Requisition field provenance — REAL signal only (mirrors the Add-Talent
// provenance posture, talent/provenance.tsx).
//
// The AI intake lane populates fields from the recruiter's intake text; those
// fields are tagged 'ai' (honest: AI drafted them). The recruiter reviews,
// edits and commits every field — an edit flips the tag to 'edited' (the
// recruiter took ownership). There is NO fabricated "needs review" /
// confidence chip — the model returns no per-field confidence, so rendering
// one would be invented (the same Lead ruling that dropped it for Add-Talent).
// Fields the recruiter types from scratch (manual lane) carry no chip.
export type ReqProvenance = 'ai' | 'edited';

export type ReqProvenanceMap = Partial<Record<string, ReqProvenance>>;

// The tag transition on a recruiter edit: 'ai' → 'edited'; 'edited' stays;
// no chip stays no chip.
export function provenanceAfterEdit(
  current: ReqProvenance | undefined,
): ReqProvenance | undefined {
  if (current === 'ai') return 'edited';
  return current;
}

export function ReqProvenanceChip({ prov }: { readonly prov?: ReqProvenance }) {
  if (prov === 'ai') {
    return (
      <span className="rc-prov rc-prov--ai">
        <Icons.IconBolt />
        AI draft
      </span>
    );
  }
  if (prov === 'edited') {
    return <span className="rc-prov rc-prov--edited">edited</span>;
  }
  return null;
}
