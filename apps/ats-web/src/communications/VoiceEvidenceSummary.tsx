import type { VoiceEngagementEvidence } from './types';

// COMM-C2A — a compact, TRUTHFUL voice-evidence summary for the recruiter drawer
// (R12). It states what evidence exists — attempt vs a two-way conversation, and
// the evidence grade — and NOTHING about qualification or client-submittal
// eligibility (that is COMM-C3, R8). Provider-neutral: no vendor key appears.

const STRENGTH_LABEL: Record<NonNullable<VoiceEngagementEvidence['evidence_strength']>, string> = {
  PROVIDER_VERIFIED: 'provider-verified',
  RECRUITER_ATTESTED: 'recruiter-attested',
};

export function VoiceEvidenceSummary({
  evidence,
}: {
  readonly evidence: VoiceEngagementEvidence | null;
}): JSX.Element {
  if (evidence === null) {
    return <p className="rc-cdp__note" data-testid="voice-evidence-loading">Loading voice activity…</p>;
  }

  if (!evidence.attempted) {
    return (
      <p className="rc-cdp__note" data-testid="voice-evidence-none">
        No voice activity recorded yet.
      </p>
    );
  }

  const twoWay = evidence.two_way_conversation;
  const strength = evidence.evidence_strength;

  return (
    <div data-testid="voice-evidence">
      <ul className="rc-cjr__checklist" style={{ margin: 0 }}>
        <li className="rc-cjr__ci rc-cjr__ci--done">
          <span className="rc-cjr__idot" aria-hidden="true">✓</span>
          <span className="rc-cjr__ilabel">Voice attempt recorded</span>
        </li>
        <li className={`rc-cjr__ci rc-cjr__ci--${twoWay ? 'done' : 'pending'}`}>
          <span className="rc-cjr__idot" aria-hidden="true">{twoWay ? '✓' : ''}</span>
          <span className="rc-cjr__ilabel">
            {twoWay ? 'Recruiter conversation recorded' : 'Conversation required'}
          </span>
          {twoWay && strength !== null ? (
            <span className="rc-cjr__chip" data-testid="voice-evidence-strength">
              {STRENGTH_LABEL[strength]}
            </span>
          ) : null}
        </li>
      </ul>
      {evidence.latest_outcome !== null ? (
        <p className="rc-cdp__note" data-testid="voice-evidence-latest">
          Latest outcome: {evidence.latest_outcome.replace(/_/g, ' ')}
        </p>
      ) : null}
    </div>
  );
}
