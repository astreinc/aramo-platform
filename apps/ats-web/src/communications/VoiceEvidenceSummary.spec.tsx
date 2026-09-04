import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { VoiceEvidenceSummary } from './VoiceEvidenceSummary';
import type { VoiceEngagementEvidence } from './types';

// COMM-C2A — the drawer voice-evidence summary must be TRUTHFUL and must NOT imply
// qualification or client-submittal eligibility (R8).

function ev(over: Partial<VoiceEngagementEvidence>): VoiceEngagementEvidence {
  return {
    talent_id: 't1',
    requisition_id: 'r1',
    attempted: false,
    two_way_conversation: false,
    evidence_strength: null,
    latest_interaction_id: null,
    latest_outcome: null,
    latest_at: null,
    ...over,
  };
}

describe('VoiceEvidenceSummary', () => {
  it('shows a loading note before evidence arrives', () => {
    render(<VoiceEvidenceSummary evidence={null} />);
    expect(screen.getByTestId('voice-evidence-loading')).toBeInTheDocument();
  });

  it('states no activity for a new talent', () => {
    render(<VoiceEvidenceSummary evidence={ev({ attempted: false })} />);
    expect(screen.getByTestId('voice-evidence-none')).toBeInTheDocument();
  });

  it('shows attempt-only as "conversation required" (not two-way)', () => {
    render(<VoiceEvidenceSummary evidence={ev({ attempted: true, latest_outcome: 'no_answer' })} />);
    expect(screen.getByText(/Voice attempt recorded/)).toBeInTheDocument();
    expect(screen.getByText(/Conversation required/)).toBeInTheDocument();
    expect(screen.queryByTestId('voice-evidence-strength')).not.toBeInTheDocument();
  });

  it('shows a two-way conversation with its evidence grade', () => {
    render(
      <VoiceEvidenceSummary
        evidence={ev({ attempted: true, two_way_conversation: true, evidence_strength: 'RECRUITER_ATTESTED', latest_outcome: 'connected' })}
      />,
    );
    expect(screen.getByText(/Recruiter conversation recorded/)).toBeInTheDocument();
    expect(screen.getByTestId('voice-evidence-strength')).toHaveTextContent('recruiter-attested');
  });

  it('never implies qualification or client-submittal eligibility', () => {
    render(
      <VoiceEvidenceSummary
        evidence={ev({ attempted: true, two_way_conversation: true, evidence_strength: 'PROVIDER_VERIFIED' })}
      />,
    );
    expect(document.body.innerHTML).not.toMatch(/qualified|eligible|submittal|submit/i);
  });
});
