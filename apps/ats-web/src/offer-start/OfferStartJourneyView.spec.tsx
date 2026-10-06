import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { remindOfferDocument, requestOfferDocument, sendOfferDocument } from '../offer-document/offer-document-api';
import { markPlacementReady } from '../pre-start/pre-start-api';
import { getTalentJourney, type TalentRequisitionJourney, type JourneyPreStart } from '../pipeline/talent-journey-api';
import { listOffers } from '../offers/offers-api';
import type { OfferView } from '../offers/types';

import { OfferStartJourneyView } from './OfferStartJourneyView';

// vitest hoists vi.mock above the imports above, so the named imports are the mocked fns.
vi.mock('../pipeline/talent-journey-api', () => ({ getTalentJourney: vi.fn() }));
vi.mock('../offers/offers-api', () => ({ listOffers: vi.fn() }));
vi.mock('../offer-document/offer-document-api', () => ({
  requestOfferDocument: vi.fn(),
  sendOfferDocument: vi.fn(),
  remindOfferDocument: vi.fn(),
}));
vi.mock('../pre-start/pre-start-api', () => ({ markPlacementReady: vi.fn() }));

function journey(
  sub: Record<string, string | null>,
  doc: TalentRequisitionJourney['offer_document'] = null,
  preStart: JourneyPreStart | null = null,
  placement: TalentRequisitionJourney['placement'] = null,
): TalentRequisitionJourney {
  const sub_states = { pipeline_stage: null, submittal_state: null, selection_state: 'SELECTED', interview_state: null, offer_state: null, placement_state: null, pre_start_state: null, assignment_state: null, ...sub };
  // Mirror the SERVER's canonical offer_start_exceptions (libs/placement
  // deriveOfferStartExceptions) — the FE renders these; it no longer derives them.
  const offer_start_exceptions: TalentRequisitionJourney['offer_start_exceptions'] = [];
  if (sub_states.offer_state === 'EXPIRED') offer_start_exceptions.push({ kind: 'offer_expired', label: 'Offer expired', detail: 'The offer expired before it was signed.' });
  if (sub_states.offer_state === 'DECLINED') offer_start_exceptions.push({ kind: 'offer_declined', label: 'Offer declined', detail: 'The talent declined the offer.' });
  if (sub_states.placement_state === 'BLOCKED') offer_start_exceptions.push({ kind: 'pre_start_blocked', label: 'Pre-start blocked', detail: 'A required pre-start requirement failed — start is blocked until resolved.' });
  return {
    requisition_id: 'r1',
    talent_record_id: 't1',
    current_journey_stage: 'OFFER',
    stages: [],
    sub_states,
    offer_start_exceptions,
    actions: [],
    offer_document: doc,
    pre_start: preStart,
    placement,
  };
}

const READY_ACTION = { action: 'Mark ready to start', owner: 'pre-start' as const, command_route: 'POST /v1/pre-start-requirement/placements/pp1/ready' };
function preStartSection(over: Partial<JourneyPreStart> = {}): JourneyPreStart {
  return {
    placement_process_id: 'pp1',
    requirements: [
      { id: 'req-1', requirement_type: 'SIGNED_OFFER', label: 'Signed offer', status: 'SATISFIED', blocking: true, owner_role: 'recruiter', completed_at: '2026-10-02T00:00:00.000Z', evidence_reference: null, remediation: null },
      { id: 'req-2', requirement_type: 'I9', label: 'Work authorization / I-9', status: 'PENDING', blocking: true, owner_role: 'compliance', completed_at: null, evidence_reference: null, remediation: { action: 'Complete Requirement', owner: 'pre-start', command_route: 'POST /v1/pre-start-requirement/requirements/req-2/status' } },
    ],
    summary: { complete: 1, total: 2 },
    readiness: { materialized: true, ready: false },
    needs_attention: [],
    ready_to_start_action: null,
    ...over,
  };
}

const OFFER: OfferView = {
  id: 'o1', tenant_id: 'T', submittal_id: 's1', requisition_id: 'r1', talent_record_id: 't1',
  state: 'SENT', proposed_start_date: '2026-10-19', offer_expires_at: '2026-10-06',
  offer_terms_summary: 'Business Analyst', decline_reason: null, created_at: '2026-08-01T00:00:00Z',
} as OfferView;

function renderAt(): void {
  render(
    <MemoryRouter initialEntries={['/offer-start/p1']}>
      <Routes>
        <Route path="offer-start/:pipelineId" element={<OfferStartJourneyView />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OfferStartJourneyView', () => {
  beforeEach(() => vi.clearAllMocks());

  it('composes the journey + offer by pipeline id; derived pill + documents + terms from server facts', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'SENT' }, { owner: 'documents', document_id: 'd1', status: 'AWAITING_SIGNATURE' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [OFFER] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('offer-start-journey')).toBeTruthy());
    // deep-link correctness: the read is keyed on the pipeline id from the route.
    expect(getTalentJourney).toHaveBeenCalledWith('p1');
    // derived pill (presentation of server state — not a stored status).
    expect(screen.getByTestId('os-pill').textContent).toBe('Awaiting signature');
    // Documents rail reflects the offer-letter DOCUMENT signal.
    expect(within(screen.getByTestId('os-doc-offer-letter')).getByText('Awaiting signature')).toBeTruthy();
    // Offer terms rail renders the authoritative talent-facing offer read.
    expect(within(screen.getByTestId('os-offer-terms')).getByText('2026-10-19')).toBeTruthy();
    // Happy path → no exceptions.
    expect(screen.queryByTestId('os-attn-offer_declined')).toBeNull();
  });

  it('declined offer → pill reflects it and Needs attention surfaces the exception', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'DECLINED' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('os-pill').textContent).toBe('Offer declined'));
    expect(screen.getByTestId('os-attn-offer_declined')).toBeTruthy();
  });

  it('REQUESTED offer letter → Review & send opens a confirm modal; confirm invokes the governed send (recipient server-resolved)', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'SENT' }, { owner: 'documents', document_id: 'd1', status: 'REQUESTED' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [OFFER] });
    vi.mocked(sendOfferDocument).mockResolvedValue({ document_id: 'd1', envelope_id: 'e1', status: 'SENT' });
    renderAt();

    fireEvent.click(await screen.findByTestId('os-action-send'));
    // review-before-send: nothing sends until confirm.
    expect(sendOfferDocument).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('os-confirm-send'));
    await waitFor(() => expect(sendOfferDocument).toHaveBeenCalledWith('d1', 'o1'));
  });

  it('AWAITING_SIGNATURE → Send reminder invokes the governed same-envelope reminder', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'SENT' }, { owner: 'documents', document_id: 'd1', status: 'AWAITING_SIGNATURE' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [OFFER] });
    vi.mocked(remindOfferDocument).mockResolvedValue({ document_id: 'd1', status: 'AWAITING_SIGNATURE', reminder_sent: true });
    renderAt();

    fireEvent.click(await screen.findByTestId('os-action-remind'));
    await waitFor(() => expect(remindOfferDocument).toHaveBeenCalledWith('d1'));
  });

  it('offer exists but no letter → Prepare offer letter invokes the governed request', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'SENT' }, null));
    vi.mocked(listOffers).mockResolvedValue({ items: [OFFER] });
    vi.mocked(requestOfferDocument).mockResolvedValue({ document_id: 'd1', offer_id: 'o1' });
    renderAt();

    fireEvent.click(await screen.findByTestId('os-action-prepare'));
    await waitFor(() => expect(requestOfferDocument).toHaveBeenCalledWith({ offer_id: 'o1' }));
  });

  it('declined → read-only: no governed action buttons are offered (§6.8)', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'DECLINED' }, null));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('os-actions')).toBeTruthy());
    expect(screen.queryByTestId('os-action-prepare')).toBeNull();
    expect(screen.queryByTestId('os-action-send')).toBeNull();
    expect(screen.queryByTestId('os-action-remind')).toBeNull();
  });

  // ---- §7 Pre-start Readiness ----

  it('pre-start section renders authoritative requirement rows + display-only N-of-M + onboarding deep-link', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'ACCEPTED', placement_state: 'PRE_START' }, null, preStartSection()));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('os-prestart')).toBeTruthy());
    expect(screen.getByTestId('os-prestart-count').textContent).toBe('1 of 2 complete');
    expect(within(screen.getByTestId('os-req-req-1')).getByText('Signed offer')).toBeTruthy();
    expect(screen.getByTestId('os-req-status-req-1').textContent).toBe('Satisfied');
    expect(screen.getByTestId('os-req-status-req-2').textContent).toBe('Pending');
    // Remediation is governed in the onboarding workspace — deep-link uses the server-owned placement id.
    expect(screen.getByTestId('os-prestart-workspace').getAttribute('href')).toBe('/onboarding/pp1');
  });

  it('Mark-ready button appears ONLY when the server exposes ready_to_start_action (fail-closed, §7.5)', async () => {
    // not ready → no button
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ placement_state: 'PRE_START' }, null, preStartSection({ readiness: { materialized: true, ready: false }, ready_to_start_action: null })));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();
    await waitFor(() => expect(screen.getByTestId('os-prestart')).toBeTruthy());
    expect(screen.queryByTestId('os-action-mark-ready')).toBeNull();
  });

  it('server says ready → Mark-ready invokes the governed markReadyToStart on the server-owned placement id', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ placement_state: 'PRE_START' }, null, preStartSection({ summary: { complete: 2, total: 2 }, readiness: { materialized: true, ready: true }, ready_to_start_action: READY_ACTION })));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    vi.mocked(markPlacementReady).mockResolvedValue({ id: 'pp1', state: 'READY_TO_START' });
    renderAt();

    fireEvent.click(await screen.findByTestId('os-action-mark-ready'));
    await waitFor(() => expect(markPlacementReady).toHaveBeenCalledWith('pp1'));
  });

  it('a FAILED blocking requirement surfaces in Needs attention (authoritative), superseding the coarse placement-BLOCKED signal (§7.6)', async () => {
    const failed = { id: 'req-9', requirement_type: 'BACKGROUND', label: 'Background check', status: 'FAILED', blocking: true, owner_role: 'compliance', completed_at: null, evidence_reference: null, remediation: { action: 'Complete Requirement', owner: 'pre-start' as const, command_route: 'POST /v1/pre-start-requirement/requirements/req-9/status' } };
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ placement_state: 'BLOCKED' }, null, preStartSection({ needs_attention: [failed] })));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('os-attn-req-req-9')).toBeTruthy());
    expect(within(screen.getByTestId('os-attn-req-req-9')).getByText('Background check failed')).toBeTruthy();
    // the coarse placement-BLOCKED exception is suppressed in favour of the specific row.
    expect(screen.queryByTestId('os-attn-pre_start_blocked')).toBeNull();
  });

  // ---- §8 Start & Placement ----

  it('READY_TO_START (contract) → the governed start is owned by the placement surface; the journey deep-links, never reimplements it (§8.2/§8.5)', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'ACCEPTED', placement_state: 'READY_TO_START' }, null, null, { id: 'pl-7', kind: 'CONTRACT' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    const link = await screen.findByTestId('os-start-link');
    expect(link.textContent).toBe('Start assignment →');
    expect(link.getAttribute('href')).toBe('/placements/pl-7'); // owner surface (commercial terms captured there)
    expect(screen.queryByTestId('os-completion-banner')).toBeNull(); // not started yet
  });

  it('STARTED (contract) → completion banner derived from placement state (presentation only, §8.4)', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'ACCEPTED', placement_state: 'STARTED' }, null, null, { id: 'pl-7', kind: 'CONTRACT' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('os-completion-banner').textContent).toContain('Started · active assignment'));
  });

  it('STARTED (direct hire / PERMANENT) → engagement diverges the completion banner to "Placement recorded" (§8.3/§8.4)', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'ACCEPTED', placement_state: 'STARTED' }, null, null, { id: 'pl-9', kind: 'PERMANENT' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    await waitFor(() => expect(screen.getByTestId('os-completion-banner').textContent).toContain('Placement recorded'));
    // direct-hire start affordance label diverges too (when still ready) — here it is already started.
  });

  it('READY_TO_START (direct hire) → start affordance label diverges to "Confirm placement"', async () => {
    vi.mocked(getTalentJourney).mockResolvedValue(journey({ offer_state: 'ACCEPTED', placement_state: 'READY_TO_START' }, null, null, { id: 'pl-9', kind: 'PERMANENT' }));
    vi.mocked(listOffers).mockResolvedValue({ items: [] });
    renderAt();

    const link = await screen.findByTestId('os-start-link');
    expect(link.textContent).toBe('Confirm placement →');
    expect(link.getAttribute('href')).toBe('/placements/pl-9');
  });
});
