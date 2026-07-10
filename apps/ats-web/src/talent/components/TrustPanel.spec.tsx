import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDossier, getDossierEvidence, resolveContradiction } from '../dossier-api';
import type { DossierHead, DossierEvidencePage } from '../dossier-api';

import { TrustPanel } from './TrustPanel';

vi.mock('../dossier-api', () => ({
  getDossier: vi.fn(),
  getDossierEvidence: vi.fn(),
  resolveContradiction: vi.fn(),
}));

function head(over: Partial<DossierHead> = {}): DossierHead {
  return {
    talent_record_id: 'r1',
    ledger_established: true,
    dimensions: {
      identity: { band: 'CORROBORATED' },
      claims: { band: 'SELF_ASSERTED' },
      continuity: { band: 'NOT_ESTABLISHED' },
      eligibility: { band: 'NOT_ESTABLISHED' },
    },
    statements: ['Observed over time'],
    contradictions: [],
    verifications: [],
    merge_provenance: [],
    advisory_pointers: [],
    proposal_pointers: [],
    ...over,
  };
}
const emptyPage: DossierEvidencePage = { items: [], next_cursor: null };

const renderPanel = (canResolve = true) =>
  render(
    <ToastProvider>
      <TrustPanel talentId="r1" canResolve={canResolve} />
    </ToastProvider>,
  );

beforeEach(() => {
  vi.mocked(getDossierEvidence).mockResolvedValue(emptyPage);
});
afterEach(() => vi.clearAllMocks());

describe('TrustPanel', () => {
  it('renders per-dimension bands + the named-thinness statement (no numbers)', async () => {
    vi.mocked(getDossier).mockResolvedValue(head());
    renderPanel();
    expect(await screen.findByText('Identity')).toBeInTheDocument();
    // the statement renders as a plain line
    expect(screen.getByText('Observed over time')).toBeInTheDocument();
    // no digit anywhere in the assessment section
    const assessment = screen.getByText('Assessment').closest('section');
    expect(assessment?.textContent ?? '').not.toMatch(/\d/);
  });

  it('renders the honest empty state for a record with no ledger', async () => {
    vi.mocked(getDossier).mockResolvedValue(head({ ledger_established: false }));
    renderPanel();
    expect(await screen.findByText('No evidence ledger for this record.')).toBeInTheDocument();
  });

  it('shows a Resolve action on a contradiction only when the actor can resolve', async () => {
    const withContra = head({
      contradictions: [
        {
          evidence_id: 'e1',
          dimension: 'CLAIMS',
          assertion_type: 'EMPLOYMENT',
          reason: 'Overlapping roles',
          contradicting_evidence_id: 'e2',
          assertion_payload: {},
        },
      ],
    });
    vi.mocked(getDossier).mockResolvedValue(withContra);
    const { unmount } = renderPanel(true);
    expect(await screen.findByText('EMPLOYMENT')).toBeInTheDocument();
    expect(screen.getByTestId('resolve-open')).toBeInTheDocument();
    unmount();

    vi.mocked(getDossier).mockResolvedValue(withContra);
    renderPanel(false);
    await screen.findByText('EMPLOYMENT');
    expect(screen.queryByTestId('resolve-open')).not.toBeInTheDocument();
  });

  it('resolve flow: dialog → endpoint → refetch', async () => {
    const withContra = head({
      contradictions: [
        { evidence_id: 'e1', dimension: 'CLAIMS', assertion_type: 'EMPLOYMENT', reason: 'x', contradicting_evidence_id: 'e2', assertion_payload: {} },
      ],
    });
    vi.mocked(getDossier).mockResolvedValue(withContra);
    vi.mocked(resolveContradiction).mockResolvedValue({ status: 'RESOLVED', evidence_id: 'e1' });
    renderPanel(true);
    fireEvent.click(await screen.findByTestId('resolve-open'));
    // justification required
    const textarea = await screen.findByPlaceholderText('Why this is not a real conflict…');
    fireEvent.change(textarea, { target: { value: 'reviewed' } });
    fireEvent.click(screen.getByTestId('contradiction-confirm'));
    await waitFor(() => expect(resolveContradiction).toHaveBeenCalledWith('e1', 'reviewed'));
    // refetch: getDossier called again after the resolve
    await waitFor(() => expect(vi.mocked(getDossier).mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
