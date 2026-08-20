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
//
// The deterministic (non-AI) "Import requisition" lane populates fields by
// parsing the recruiter's pasted client requirement; those fields are tagged
// 'parsed' — an HONEST, distinct signal that is NEVER the 'ai' label. Labelling
// client-stated facts as AI-authored would be a false trust signal (Directive
// REQ-DET-INTAKE-1; ADR-0015 posture). A recruiter edit flips 'parsed' → 'edited'
// exactly as it does for 'ai'.
export type ReqProvenance = 'ai' | 'parsed' | 'edited';

export type ReqProvenanceMap = Partial<Record<string, ReqProvenance>>;

// The tag transition on a recruiter edit: a machine-prefilled tag ('ai' or
// 'parsed') → 'edited'; 'edited' stays; no chip stays no chip.
export function provenanceAfterEdit(
  current: ReqProvenance | undefined,
): ReqProvenance | undefined {
  if (current === 'ai' || current === 'parsed') return 'edited';
  return current;
}

// Machine-prefilled (not yet recruiter-owned) — drives the input highlight for
// BOTH the AI and the parsed lanes, without conflating their honest chips.
export function isPrefilled(prov: ReqProvenance | undefined): boolean {
  return prov === 'ai' || prov === 'parsed';
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
  if (prov === 'parsed') {
    return (
      <span className="rc-prov rc-prov--parsed">
        <Icons.IconFile />
        Parsed
      </span>
    );
  }
  if (prov === 'edited') {
    return <span className="rc-prov rc-prov--edited">edited</span>;
  }
  return null;
}
