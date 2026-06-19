import { Icons } from '../ui';

// Field provenance — REAL signal only.
//
// The résumé parse returns { prefill, parse_status } with NO per-field
// confidence (libs/resume-parse ParseResumeResult). So the only honest
// provenance we can render is:
//   - 'resume': the field was populated from the parsed prefill and the
//               recruiter has NOT changed it.
//   - 'edited': the field came from the prefill and the recruiter has since
//               changed it.
// The mockup's "needs review" (low-confidence) chip is DROPPED — there is no
// confidence signal behind it, so rendering it would be fabricated (Lead
// ruling). Fields the recruiter types from scratch carry no chip.
export type Provenance = 'resume' | 'edited';

export type ProvenanceMap = Partial<Record<string, Provenance>>;

export function ProvenanceChip({ prov }: { readonly prov?: Provenance }) {
  if (prov === 'resume') {
    return (
      <span className="rc-prov rc-prov--resume">
        <Icons.IconFile />
        résumé
      </span>
    );
  }
  if (prov === 'edited') {
    return <span className="rc-prov rc-prov--edited">edited</span>;
  }
  return null;
}
