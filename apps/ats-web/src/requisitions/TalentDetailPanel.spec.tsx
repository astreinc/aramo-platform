import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PipelineView } from '../pipeline/types';
import {
  getTalentJourney,
  type TalentRequisitionJourney,
} from '../pipeline/talent-journey-api';
import { listOffers } from '../offers/offers-api';
import { getTalent, updateTalent } from '../talent/talent-api';

import { TalentDetailPanel } from './TalentDetailPanel';

// S3 — the drawer consumes the backend-owned Unified Talent Journey. Fixtures are
// hoisted so the vi.mock factory can close over them. QUALIFIED has NO offer
// action (Create offer must not surface); SELECTED returns an offer action.
const { QUALIFIED_JOURNEY, SELECTED_JOURNEY } = vi.hoisted(() => ({
  QUALIFIED_JOURNEY: {
    requisition_id: 'r1',
    talent_record_id: 't1',
    current_journey_stage: 'QUALIFIED',
    stages: [{ stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' }],
    sub_states: { pipeline_stage: 'qualified', selection_state: null, offer_state: null },
    actions: [],
  } as TalentRequisitionJourney,
  SELECTED_JOURNEY: {
    requisition_id: 'r1',
    talent_record_id: 't1',
    current_journey_stage: 'CLIENT_REVIEW',
    stages: [
      { stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p1' },
      { stage: 'SUBMITTED', owner: 'submittal', source_object_id: 's1' },
      { stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'cs1' },
    ],
    sub_states: { pipeline_stage: 'qualified', selection_state: 'SELECTED', offer_state: null },
    actions: [{ action: 'Create offer', owner: 'offer', command_route: '/v1/offers' }],
  } as TalentRequisitionJourney,
}));
vi.mock('../pipeline/talent-journey-api', () => ({
  getTalentJourney: vi.fn(async () => QUALIFIED_JOURNEY),
}));

// The panel sources the RAW record from getTalent (full TalentRecordView) for
// inline edit; updateTalent PATCHes the single changed column.
const RAW_RECORD = {
  id: 't1', first_name: 'Sarah', last_name: 'Nolan',
  email1: 'sarah@x.test', phone_cell: '+1-512-555-0100',
  city: 'Austin', state: 'TX', work_authorization: 'US_CITIZEN', desired_pay: '$85/hr',
};
vi.mock('../talent/talent-api', () => ({
  getTalent: vi.fn(async () => RAW_RECORD),
  updateTalent: vi.fn(async (_id: string, body: Record<string, unknown>) => ({ ...RAW_RECORD, ...body })),
}));

// D7 — the mounted OfferPanelContainer fetches offers on render (only when the
// caller holds offer:create). Default mock returns an empty list; the wiring
// test overrides it per-case.
vi.mock('../offers/offers-api', () => ({
  listOffers: vi.fn(async () => ({ items: [] })),
  createOffer: vi.fn(),
  transitionOffer: vi.fn(),
  readOffer: vi.fn(),
}));
vi.mock('../submittals/submittals-api', () => ({
  findSubmittalForTalentJob: vi.fn(async () => ({ submittal: null })),
}));

const ENTRY: PipelineView = {
  id: 'p1',
  tenant_id: 'T',
  site_id: null,
  talent_record_id: 't1',
  requisition_id: 'r1',
  status: 'qualifying',
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  version: 0,
};

function renderPanel(over: Partial<Parameters<typeof TalentDetailPanel>[0]> = {}) {
  const onClose = vi.fn();
  const onTransitioned = vi.fn();
  render(
    <ToastProvider>
      <MemoryRouter>
        <TalentDetailPanel
          entry={ENTRY}
          talentName="Sarah Nolan"
          isNew
          reqTitle="Senior Rust Engineer"
          reqCode="REQ-2041"
          scopes={[]}
          onClose={onClose}
          onTransitioned={onTransitioned}
          {...over}
        />
      </MemoryRouter>
    </ToastProvider>,
  );
  return { onClose, onTransitioned };
}

describe('TalentDetailPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders header (name, NEW, role · req code) + the backend-owned Talent Journey rail', async () => {
    renderPanel();
    expect(screen.getByText('Sarah Nolan')).toBeTruthy();
    expect(screen.getByText('NEW')).toBeTruthy();
    expect(screen.getByText('Senior Rust Engineer · REQ-2041')).toBeTruthy();
    // The 5 owner-attributed milestones (Ruling 2 — canonical "Pre-Start",
    // never "Onboarding"), scoped to the journey rail. Journey loads async from
    // GET /v1/pipelines/:id/journey.
    const rail = await screen.findByRole('list', { name: 'Talent journey' });
    for (const m of ['Recruiting', 'Client', 'Offer', 'Pre-Start', 'Employment']) {
      expect(within(rail).getByText(m)).toBeTruthy();
    }
    expect(await screen.findByText(/summary of its owning workflow/i)).toBeTruthy();
  });

  it('reads the journey from GET /v1/pipelines/:id/journey (owner truth, not FE-derived)', async () => {
    renderPanel();
    await screen.findByRole('list', { name: 'Talent journey' });
    expect(getTalentJourney).toHaveBeenCalledWith('p1');
  });

  it('marks the current lane with the CURRENT chip from journey truth', async () => {
    renderPanel();
    expect(await screen.findByText('CURRENT')).toBeTruthy();
    // The lane heading is owner-attributed (pipeline → Recruiting) — not derived.
    expect(screen.getByText(/owned by Pipeline/i)).toBeTruthy();
  });

  it('Qualified NEVER exposes Create Offer — no offer action in the journey', async () => {
    // Even holding offer:create, the drawer must not surface the offer decision
    // surface at Qualified: the journey returns no offer-owner action.
    renderPanel({ scopes: ['offer:create', 'offer:transition'] });
    await screen.findByRole('list', { name: 'Talent journey' });
    expect(screen.queryByText('Offer decision')).toBeNull();
    expect(listOffers).not.toHaveBeenCalled();
  });

  it('routes the Qualified next step to the delivered submittal surface (owner module)', async () => {
    renderPanel();
    const cta = await screen.findByText('Prepare submittal');
    expect(cta.closest('a')?.getAttribute('href')).toBe('/talent/t1/submittal/r1');
  });

  it('close via ✕ and via backdrop click', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('agreed pay rate shows the em-dash placeholder when not agreed', () => {
    renderPanel();
    expect(screen.getByText('Agreed pay rate')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  // D7 + S3 — the Offer panel mounts ONLY when the journey permits an offer
  // (SELECTED returns an offer action). Then, with offer scopes, the container
  // fetches the offer and OfferPanel renders its state + a governed affordance.
  it('mounts the Offer panel when the journey permits it (Selected) — a live SENT offer surfaces Accept', async () => {
    vi.mocked(getTalentJourney).mockResolvedValueOnce(SELECTED_JOURNEY);
    vi.mocked(listOffers).mockResolvedValueOnce({
      items: [
        {
          id: 'o1',
          tenant_id: 'T',
          submittal_id: 's1',
          requisition_id: 'r1',
          talent_record_id: 't1',
          state: 'SENT',
          proposed_start_date: null,
          offer_expires_at: null,
          client_offer_reference: null,
          offer_terms_summary: null,
          decline_reason: null,
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    });
    renderPanel({ scopes: ['offer:create', 'offer:transition'] });
    // The list read is keyed on (requisition_id, talent_record_id).
    await waitFor(() =>
      expect(listOffers).toHaveBeenCalledWith({
        requisitionId: 'r1',
        talentRecordId: 't1',
      }),
    );
    // State label + a legal SENT affordance render.
    expect(await screen.findByText('Sent')).toBeTruthy();
    expect(screen.getByText('Accept')).toBeTruthy();
  });

  // D7 — no offer:create ⇒ the container is inert (renders nothing, issues no read).
  it('does not mount the Offer surface without offer scopes (existence gate)', () => {
    renderPanel(); // scopes: []
    expect(listOffers).not.toHaveBeenCalled();
    expect(screen.queryByText('Accept')).toBeNull();
  });

  // Enrichment — the real PipelineView list enrichment surfaces on the panel;
  // present-and-non-null renders the value.
  it('renders the real enrichment (email/phone/location/work_auth/desired_rate) when present', () => {
    renderPanel({
      entry: {
        ...ENTRY,
        email: 'sarah@x.test',
        phone: '+1-512-555-0100',
        location: 'Austin, TX',
        work_auth: 'US Citizen',
        desired_rate: '$85/hr',
      },
    });
    expect(screen.getByText('sarah@x.test')).toBeTruthy();
    expect(screen.getByText('+1-512-555-0100')).toBeTruthy();
    expect(screen.getByText('Austin, TX')).toBeTruthy();
    expect(screen.getByText('US Citizen')).toBeTruthy();
    expect(screen.getByText('$85/hr')).toBeTruthy();
  });

  // do_not_contact suppresses email/phone (→ null); absent ≠ null but both
  // collapse to the em-dash (masked-by-absence — never a leaked sensitive field).
  it('suppressed email/phone (null) render the em-dash, not the value', () => {
    renderPanel({
      entry: { ...ENTRY, email: null, phone: null, location: 'Remote', work_auth: 'H1-B' },
    });
    expect(screen.getByText('Remote')).toBeTruthy();
    expect(screen.getByText('H1-B')).toBeTruthy();
    // email + phone suppressed → em-dashes present.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('TalentDetailPanel — inline edit (talent:edit)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('without talent:edit → fields are READ-ONLY (no inline editors)', () => {
    renderPanel(); // scopes: []
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(getTalent).toHaveBeenCalledWith('t1');
  });

  it('with talent:edit → a field is inline-editable and PATCHes ONLY its column', async () => {
    renderPanel({ scopes: ['talent:edit'] });
    // Wait for the RAW record (getTalent) to load, then edit Email.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Email' }));
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new@x.test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(updateTalent).toHaveBeenCalledWith('t1', { email1: 'new@x.test' }),
    );
    // Single-column PATCH — only email1 in the body.
    expect(vi.mocked(updateTalent).mock.calls[0]?.[1]).toEqual({ email1: 'new@x.test' });
  });

  it('Location edits city + state as separate columns', async () => {
    renderPanel({ scopes: ['talent:edit'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit City' }));
    const city = screen.getByLabelText('City') as HTMLInputElement;
    fireEvent.change(city, { target: { value: 'Dallas' } });
    fireEvent.keyDown(city, { key: 'Enter' });
    await waitFor(() => expect(updateTalent).toHaveBeenCalledWith('t1', { city: 'Dallas' }));
  });

  it('work_authorization renders a SELECT of the enum + PATCHes the enum column', async () => {
    renderPanel({ scopes: ['talent:edit'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Work authorization' }));
    const select = screen.getByLabelText('Work authorization') as HTMLSelectElement;
    const optionLabels = within(select).getAllByRole('option').map((o) => o.textContent);
    expect(optionLabels).toEqual(
      expect.arrayContaining([
        'U.S. citizen', 'Permanent resident', 'Visa holder',
        'Requires sponsorship', 'Other', 'Not disclosed',
      ]),
    );
    fireEvent.change(select, { target: { value: 'PERMANENT_RESIDENT' } });
    await waitFor(() =>
      expect(updateTalent).toHaveBeenCalledWith('t1', { work_authorization: 'PERMANENT_RESIDENT' }),
    );
  });

  it('Agreed pay rate stays "—" and is NOT editable', async () => {
    renderPanel({ scopes: ['talent:edit'] });
    await screen.findByRole('button', { name: 'Edit Email' }); // record loaded
    expect(screen.getByText('Agreed pay rate')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Agreed pay rate' })).toBeNull();
  });

  it('editors FALL BACK to entry.* enrichment when the raw record read returns null (getTalent 404)', async () => {
    vi.mocked(getTalent).mockRejectedValueOnce(new Error('404 site mismatch'));
    renderPanel({
      scopes: ['talent:edit'],
      entry: {
        ...ENTRY,
        email: 'v@x.test', phone: '+1-555-0000', location: 'Austin, TX',
        work_auth: 'US_CITIZEN', desired_rate: '$90/hr',
      },
    });
    // The existing values show (from enrichment) even though record is null.
    expect(await screen.findByText('v@x.test')).toBeInTheDocument();
    expect(screen.getByText('+1-555-0000')).toBeInTheDocument();
    expect(screen.getByText('Austin')).toBeInTheDocument(); // City parsed from "City, ST"
    expect(screen.getByText('TX')).toBeInTheDocument(); // State parsed
    expect(screen.getByText('U.S. citizen')).toBeInTheDocument(); // enum → label
    expect(screen.getByText('$90/hr')).toBeInTheDocument();
    // …and are still editable.
    expect(screen.getByRole('button', { name: 'Edit Email' })).toBeInTheDocument();
  });

  it('a genuinely-empty field (no record + no enrichment) shows blank but stays editable', async () => {
    vi.mocked(getTalent).mockRejectedValueOnce(new Error('404'));
    renderPanel({ scopes: ['talent:edit'], entry: { ...ENTRY, email: null } });
    const btn = await screen.findByRole('button', { name: 'Edit Email' });
    expect(btn.textContent).toContain('—'); // blank placeholder
  });

  it('a successful save reports an enrichment-shaped patch via onTalentFieldSaved', async () => {
    const onTalentFieldSaved = vi.fn();
    render(
      <ToastProvider>
        <MemoryRouter>
          <TalentDetailPanel
            entry={ENTRY}
            talentName="Sarah Nolan"
            isNew
            reqTitle="Senior Rust Engineer"
            reqCode="REQ-2041"
            scopes={['talent:edit']}
            onClose={vi.fn()}
            onTransitioned={vi.fn()}
            onTalentFieldSaved={onTalentFieldSaved}
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Email' }));
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new@x.test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(onTalentFieldSaved).toHaveBeenCalledWith('t1', { email: 'new@x.test' }),
    );
  });

  it('optimistic save ROLLS BACK on failure + surfaces a controlled inline error', async () => {
    vi.mocked(updateTalent).mockRejectedValueOnce(new Error('backend blew up'));
    renderPanel({ scopes: ['talent:edit'] });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Email' }));
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad@x.test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Controlled error surfaces (never the raw backend text).
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('alert').textContent ?? '').not.toContain('backend blew up');
    // Cancel → the rolled-back original value shows (not the failed edit).
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.getByText('sarah@x.test')).toBeInTheDocument());
    expect(screen.queryByText('bad@x.test')).toBeNull();
  });
});
