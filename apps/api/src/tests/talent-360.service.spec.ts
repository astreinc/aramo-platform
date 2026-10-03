import { describe, expect, it } from 'vitest';

import { RECRUITING_READY_RULE, Talent360Service } from '../talent-360/talent-360.service.js';
import type {
  ConsentSummaryValue,
  DocumentRow,
  EpisodeRow,
  IdentityOutcomeRow,
  InterviewScheduleRow,
  LastContactRow,
  RequisitionSummaryRow,
  Talent360ActorContext,
  Talent360ReadPort,
  TalentCoreRow,
} from '../talent-360/talent-360.ports.js';
import type { TalentRequisitionJourney } from '../talent-journey/dto/talent-journey.view.js';

// Talent 360 composes AUTHORIZED TRUTH; it does not become the authority. Every
// test name restates that invariant: composition reflects the owning domains,
// gates each section on its own scope, and never fabricates or persists state.

const TZ = 'America/New_York';
const NOW = Date.parse('2026-09-29T16:00:00Z'); // Tue Sep 29, midday EDT

const ALL_SCOPES = [
  'talent:read',
  'pipeline:read',
  'task:read',
  'activity:read',
  'communication:read',
  'document:read',
];

function ctx(scopes: readonly string[] = ALL_SCOPES): Talent360ActorContext {
  return {
    tenant_id: 't-1',
    user_id: 'u-1',
    visibility: {
      tenant_id: 't-1',
      actor_user_id: 'u-1',
      see_all_company: false,
      see_all_requisition: false,
      visible_client_ids: null,
    },
    visible_requisition_ids: new Set(['req-1', 'req-2', 'req-3']),
    visible_contact_ids: null,
    scopes: new Set(scopes),
    request_id: 'rq-1',
  };
}

function core(overrides: Partial<TalentCoreRow> = {}): TalentCoreRow {
  return {
    id: 'tal-1',
    first_name: 'Divya',
    last_name: 'Vasudevan',
    title: 'Scrum Master',
    city: 'Vienna',
    state: 'VA',
    email1: 'divya@example.com',
    phone_cell: '(703) 555-0182',
    work_authorization: 'permanent_resident',
    desired_pay: '$85/hr',
    current_pay: null,
    engagement_type: 'c2c',
    availability_status: 'available_now',
    date_available: null,
    key_skills: 'Scrum, SAFe, Jira',
    source: 'Referral sourcing',
    owner_id: 'u-1',
    created_at: '2024-03-01T00:00:00Z',
    recruiting_ready: true,
    record_status: 'live',
    superseded_by_record_id: null,
    ...overrides,
  };
}

function episode(id: string, requisition_id: string, status: string): EpisodeRow {
  return { id, requisition_id, status, created_at: '2026-09-20T00:00:00Z', updated_at: '2026-09-28T00:00:00Z' };
}

function req(id: string, n: number): RequisitionSummaryRow {
  return {
    id,
    requisition_number: n,
    title: `Role ${n}`,
    company_id: `co-${n}`,
    status: 'open',
    is_hot: false,
    owner_id: 'u-2',
    recruiter_id: 'u-2',
  };
}

// A journey with only the sub_states/stages a test exercises.
function journey(
  requisition_id: string,
  sub: Partial<TalentRequisitionJourney['sub_states']>,
  stages: TalentRequisitionJourney['stages'] = [],
): TalentRequisitionJourney {
  return {
    requisition_id,
    talent_record_id: 'tal-1',
    current_journey_stage: 'QUALIFIED',
    stages,
    sub_states: {
      pipeline_stage: 'qualified',
      submittal_state: null,
      selection_state: null,
      interview_state: null,
      offer_state: null,
      placement_state: null,
      pre_start_state: null,
      assignment_state: null,
      ...sub,
    },
    actions: [],
  };
}

function fakePort(overrides: Partial<Talent360ReadPort> = {}): Talent360ReadPort {
  const base: Talent360ReadPort = {
    loadTalent: async () => core(),
    listEpisodes: async () => [],
    composeJourney: async () => journey('req-1', {}),
    resolveRequisitions: async () => new Map(),
    resolveCompanyNames: async () => new Map(),
    resolveUserNames: async () => new Map(),
    resolveDispositionReasons: async () => new Map(),
    findLatestInterview: async () => null,
    lastContact: async () => null,
    listRecentCommunications: async () => [],
    listRecentActivity: async () => [],
    listTasks: async () => [],
    listDocuments: async () => [],
    loadConsentSummary: async () => 'do_not_contact' as ConsentSummaryValue,
    loadIdentityOutcomes: async () =>
      ({ primary_email_confirmed: false, mobile_confirmed: false, advisory: null }) as IdentityOutcomeRow,
    listWorkHistory: async () => [],
  };
  return { ...base, ...overrides };
}

function svc(port: Talent360ReadPort): Talent360Service {
  return new Talent360Service(port);
}

describe('Talent360Service — composes authorized truth, is not the authority', () => {
  it('rejects with NOT_FOUND when the Talent does not exist in tenant (never invents a record)', async () => {
    const service = svc(fakePort({ loadTalent: async () => null }));
    await expect(service.compose(ctx(), 'missing', NOW, TZ)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  it('short-circuits a superseded record: header carries the survivor pointer, every section suppressed (never resurrects identity)', async () => {
    const service = svc(
      fakePort({
        loadTalent: async () =>
          core({ record_status: 'superseded', superseded_by_record_id: 'tal-2' }),
      }),
    );
    const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
    expect(v.header.record_status).toBe('superseded');
    expect(v.header.superseded_by_record_id).toBe('tal-2');
    expect(v.opportunities).toBeNull();
    expect(v.tasks).toBeNull();
    expect(v.documents).toBeNull();
    expect(v.identity).toBeNull();
    expect(v.recent_activity).toBeNull();
    expect(v.relationship_strip.active_opportunities).toBeNull();
    expect(Object.values(v.authorized_sections).every((x) => x === false)).toBe(true);
  });

  describe('per-section scope gating — an absent scope hides its section, the rest of the page still succeeds', () => {
    it('omits opportunities + strip counts when pipeline:read is absent (authorized-hidden, not empty)', async () => {
      const service = svc(fakePort());
      const v = await service.compose(ctx(ALL_SCOPES.filter((s) => s !== 'pipeline:read')), 'tal-1', NOW, TZ);
      expect(v.opportunities).toBeNull();
      expect(v.attention).toBeNull();
      expect(v.relationship_strip.active_opportunities).toBeNull();
      expect(v.authorized_sections.opportunities).toBe(false);
      // The rest of the page is unaffected — composition degrades per-section.
      expect(v.header.display_name).toBe('Divya Vasudevan');
      expect(v.profile).toBeDefined();
      expect(v.relationship).toBeDefined();
    });

    it('omits documents when document:read is absent, and the rest of Talent 360 still renders', async () => {
      const service = svc(fakePort({ listDocuments: async () => [docRow()] }));
      const v = await service.compose(ctx(ALL_SCOPES.filter((s) => s !== 'document:read')), 'tal-1', NOW, TZ);
      expect(v.documents).toBeNull();
      expect(v.authorized_sections.documents).toBe(false);
      expect(v.header.display_name).toBe('Divya Vasudevan');
    });

    it('omits tasks when task:read is absent', async () => {
      const service = svc(fakePort());
      const v = await service.compose(ctx(ALL_SCOPES.filter((s) => s !== 'task:read')), 'tal-1', NOW, TZ);
      expect(v.tasks).toBeNull();
      expect(v.authorized_sections.tasks).toBe(false);
    });

    it('omits recent activity + last-contact when neither activity:read nor communication:read is held', async () => {
      const service = svc(fakePort({ lastContact: async () => ({ at: '2026-09-29T13:14:00Z', channel: 'email' }) }));
      const v = await service.compose(
        ctx(['talent:read', 'pipeline:read', 'task:read', 'document:read']),
        'tal-1',
        NOW,
        TZ,
      );
      expect(v.recent_activity).toBeNull();
      expect(v.relationship_strip.last_contact).toBeNull();
      expect(v.authorized_sections.communications).toBe(false);
    });
  });

  describe('KPI derivation — every count reflects the owning domains, never a maintained Talent counter', () => {
    it('derives active/submittals/interviews-today/offers/assignments from the composed journeys', async () => {
      const episodes = [
        episode('pipe-1', 'req-1', 'qualified'),
        episode('pipe-2', 'req-2', 'qualified'),
        episode('pipe-3', 'req-3', 'qualified'),
      ];
      const journeys: Record<string, TalentRequisitionJourney> = {
        'pipe-1': journey('req-1', { submittal_state: 'submitted_to_client', selection_state: 'INTERVIEW', interview_state: 'SCHEDULED' }, [
          { stage: 'INTERVIEW', owner: 'client-selection', source_object_id: 'csp-1' },
        ]),
        'pipe-2': journey('req-2', { submittal_state: 'submitted_to_client', selection_state: 'CLIENT_REVIEW' }, [
          { stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'csp-2', occurred_at: '2026-09-26T12:00:00Z' },
        ]),
        'pipe-3': journey('req-3', { submittal_state: 'confirmed', offer_state: 'ACCEPTED', placement_state: 'STARTED' }),
      };
      const service = svc(
        fakePort({
          listEpisodes: async () => episodes,
          composeJourney: async (_c, id) => journeys[id]!,
          resolveRequisitions: async () => new Map([['req-1', req('req-1', 1001)], ['req-2', req('req-2', 1032)], ['req-3', req('req-3', 1048)]]),
          findLatestInterview: async (_c, processId): Promise<InterviewScheduleRow | null> =>
            processId === 'csp-1' ? { scheduled_at: '2026-09-29T20:00:00Z', state: 'SCHEDULED', interview_type: 'client_panel', round: 1 } : null,
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      const strip = v.relationship_strip;
      expect(strip.active_opportunities).toBe(3);
      expect(strip.submittals).toBe(3);
      expect(strip.interviews_today).toBe(1);
      expect(strip.offers).toBe(1);
      expect(strip.assignments).toBe(1);
      expect(v.opportunities?.active).toHaveLength(3);
    });

    it('assignments count is STARTED placements only (HALT-4), not offers or non-started placements', async () => {
      const journeys: Record<string, TalentRequisitionJourney> = {
        'pipe-a': journey('req-1', { placement_state: 'PRE_START' }),
        'pipe-b': journey('req-2', { placement_state: 'STARTED' }),
      };
      const service = svc(
        fakePort({
          listEpisodes: async () => [episode('pipe-a', 'req-1', 'qualified'), episode('pipe-b', 'req-2', 'qualified')],
          composeJourney: async (_c, id) => journeys[id]!,
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      expect(v.relationship_strip.assignments).toBe(1);
    });
  });

  describe('attention derivation — self-clearing, sourced from live journey state (§9)', () => {
    it('surfaces an interview-today item from real interview state and a waiting item from client-selection created_at', async () => {
      const journeys: Record<string, TalentRequisitionJourney> = {
        'pipe-1': journey('req-1', { selection_state: 'INTERVIEW', interview_state: 'SCHEDULED' }, [
          { stage: 'INTERVIEW', owner: 'client-selection', source_object_id: 'csp-1' },
        ]),
        'pipe-2': journey('req-2', { selection_state: 'CLIENT_REVIEW' }, [
          { stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'csp-2', occurred_at: '2026-09-26T12:00:00Z' },
        ]),
      };
      const service = svc(
        fakePort({
          listEpisodes: async () => [episode('pipe-1', 'req-1', 'qualified'), episode('pipe-2', 'req-2', 'qualified')],
          composeJourney: async (_c, id) => journeys[id]!,
          resolveRequisitions: async () => new Map([['req-1', req('req-1', 1001)], ['req-2', req('req-2', 1032)]]),
          findLatestInterview: async () => ({ scheduled_at: '2026-09-29T20:00:00Z', state: 'SCHEDULED', interview_type: 'client_panel', round: 1 }),
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      const kinds = (v.attention ?? []).map((a) => a.kind);
      expect(kinds).toContain('interview');
      expect(kinds).toContain('waiting');
      const waiting = v.attention!.find((a) => a.kind === 'waiting')!;
      expect(waiting.kicker).toBe('WAITING 3 DAYS');
    });

    it('never fabricates a "talent confirmed" interview micro-state (PROTOTYPE-ONLY, HALT-6): no confirmation field, no "confirmed" copy', async () => {
      const j = journey('req-1', { selection_state: 'INTERVIEW', interview_state: 'SCHEDULED' }, [
        { stage: 'INTERVIEW', owner: 'client-selection', source_object_id: 'csp-1' },
      ]);
      const service = svc(
        fakePort({
          listEpisodes: async () => [episode('pipe-1', 'req-1', 'qualified')],
          composeJourney: async () => j,
          resolveRequisitions: async () => new Map([['req-1', req('req-1', 1001)]]),
          findLatestInterview: async () => ({ scheduled_at: '2026-09-29T20:00:00Z', state: 'SCHEDULED', interview_type: 'client_panel', round: 1 }),
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      const opp = v.opportunities!.active[0]!;
      expect(opp).not.toHaveProperty('confirmation');
      const interviewAttention = v.attention!.find((a) => a.kind === 'interview')!;
      expect(interviewAttention.title.toLowerCase()).not.toContain('confirmed');
    });
  });

  describe('empty states — authorized-but-none is [] / zero, never a fabricated warning (§24)', () => {
    it('a Talent with no opportunities yields empty opportunities and zero (not null) strip counts under pipeline:read', async () => {
      const service = svc(fakePort({ listEpisodes: async () => [] }));
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      expect(v.opportunities).toEqual({ active: [], closed: [] });
      expect(v.relationship_strip.active_opportunities).toBe(0);
      expect(v.relationship_strip.submittals).toBe(0);
      expect(v.attention).toEqual([]);
    });
  });

  describe('relationship history — single TalentRecord semantics (HALT-5), no merged-human lifetime claim', () => {
    it('counts requisitions as active + closed episodes for THIS record only', async () => {
      const service = svc(
        fakePort({
          listEpisodes: async () => [
            episode('pipe-1', 'req-1', 'qualified'),
            episode('pipe-2', 'req-2', 'not_in_consideration'),
          ],
          composeJourney: async () => journey('req-1', { submittal_state: 'submitted_to_client', interview_state: 'SCHEDULED' }),
          resolveRequisitions: async () => new Map([['req-1', req('req-1', 1001)], ['req-2', req('req-2', 1032)]]),
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      // 1 active + 1 closed = 2 requisitions; the one active journey carries a
      // submittal + interview.
      expect(v.relationship.history.requisitions).toBe(2);
      expect(v.relationship.history.submittals).toBe(1);
      expect(v.relationship.history.interviews).toBe(1);
    });
  });

  describe('recruiting_ready — the landed predicate is preserved EXACTLY (HALT-1), never enriched with consent/identity', () => {
    it('passes core.recruiting_ready through and renders the honest rule, independent of consent state', async () => {
      const service = svc(
        fakePort({
          loadTalent: async () => core({ recruiting_ready: true }),
          loadConsentSummary: async () => 'do_not_contact',
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      // Ready stays true even though contact is not permitted — no consent
      // semantics are folded into the badge.
      expect(v.header.recruiting_ready.ready).toBe(true);
      expect(v.header.recruiting_ready.rule).toBe(RECRUITING_READY_RULE);
      expect(v.header.recruiting_ready.rule.toLowerCase()).not.toContain('consent');
      expect(v.header.recruiting_ready.rule.toLowerCase()).not.toContain('identity');
    });
  });

  describe('contactability — from the consent authority, never inferred from email/phone presence (§6.6)', () => {
    it('reports Contact permitted only when the consent summary is contactable', async () => {
      const permitted = svc(fakePort({ loadConsentSummary: async () => 'contactable' }));
      const denied = svc(fakePort({ loadConsentSummary: async () => 'do_not_contact' }));
      const vp = await permitted.compose(ctx(), 'tal-1', NOW, TZ);
      const vd = await denied.compose(ctx(), 'tal-1', NOW, TZ);
      expect(vp.header.contactability.recruiting_permitted).toBe(true);
      expect(vd.header.contactability.recruiting_permitted).toBe(false);
      // Email is present on both cores, but the permit follows consent, not presence.
      expect(vd.header.actions.can_email).toBe(false);
    });
  });

  describe('last contact — from communications, not the generic activity log (§6.2)', () => {
    it('surfaces the communications top-1 contact (channel + instant) under communication:read', async () => {
      const lc: LastContactRow = { at: '2026-09-29T13:14:00Z', channel: 'email' };
      const service = svc(fakePort({ lastContact: async () => lc }));
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      expect(v.relationship_strip.last_contact).toEqual(lc);
    });
  });

  describe('documents — signed state from the Documents authority, displayed not stored (§13)', () => {
    it('marks a document signed iff status is EXECUTED, carrying executed_at as signed_at', async () => {
      const service = svc(
        fakePort({
          listDocuments: async () => [
            docRow({ id: 'd-rtr', document_type_name: 'Right to Represent', status: 'EXECUTED', executed_at: '2026-09-26T00:00:00Z' }),
            docRow({ id: 'd-res', document_type_name: 'Résumé', status: 'DRAFT', executed_at: null }),
          ],
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      const byId = new Map(v.documents!.key_documents.map((d) => [d.id, d]));
      expect(byId.get('d-rtr')!.signed).toBe(true);
      expect(byId.get('d-rtr')!.signed_at).toBe('2026-09-26T00:00:00Z');
      expect(byId.get('d-res')!.signed).toBe(false);
      expect(v.documents!.total).toBe(2);
    });
  });

  describe('identity — outcomes from the advisory/dossier authority, never a Talent boolean (§14)', () => {
    it('reflects confirmed anchors and a pending duplicate advisory from the dossier', async () => {
      const service = svc(
        fakePort({
          loadIdentityOutcomes: async () => ({
            primary_email_confirmed: true,
            mobile_confirmed: true,
            advisory: { advisory_id: 'adv-1', label: 'Possible duplicate needs review' },
          }),
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      expect(v.identity!.primary_email_confirmed).toBe(true);
      expect(v.identity!.mobile_confirmed).toBe(true);
      expect(v.identity!.advisory).toEqual({ advisory_id: 'adv-1', label: 'Possible duplicate needs review' });
    });
  });

  describe('ownership — owner_id is provenance, "also working with" derives from opportunity recruiters (HALT-2)', () => {
    it('labels owner as provenance and derives also-working-with from active-opportunity recruiters', async () => {
      const service = svc(
        fakePort({
          loadTalent: async () => core({ owner_id: 'u-1' }),
          listEpisodes: async () => [episode('pipe-1', 'req-1', 'qualified')],
          composeJourney: async () => journey('req-1', {}),
          resolveRequisitions: async () => new Map([['req-1', req('req-1', 1001)]]),
          resolveUserNames: async () => new Map([['u-1', 'Purush P.'], ['u-2', 'Sanjay Kumar']]),
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      expect(v.relationship.ownership.owner_provenance).toEqual({ user_id: 'u-1', name: 'Purush P.' });
      const also = v.relationship.ownership.also_working_with;
      expect(also.map((a) => a.name)).toContain('Sanjay Kumar');
    });
  });

  describe('CRM-5 — relationship + past-opportunity deltas', () => {
    it('§9.4 derives "worked with before" from CLOSED episodes (recruiter attribution), excluding the active set', async () => {
      const service = svc(
        fakePort({
          loadTalent: async () => core({ owner_id: 'u-1' }),
          listEpisodes: async () => [
            episode('pipe-1', 'req-1', 'qualified'), // active → also_working_with (u-2)
            episode('pipe-2', 'req-2', 'not_in_consideration'), // closed → worked_with_before (u-3)
          ],
          composeJourney: async () => journey('req-1', {}),
          resolveRequisitions: async () =>
            new Map([
              ['req-1', req('req-1', 1001)], // recruiter u-2
              ['req-2', { ...req('req-2', 1002), recruiter_id: 'u-3', owner_id: 'u-3' }],
            ]),
          resolveUserNames: async () =>
            new Map([
              ['u-1', 'Purush P.'],
              ['u-2', 'Sanjay Kumar'],
              ['u-3', 'Dana Ortiz'],
            ]),
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      const before = v.relationship.ownership.worked_with_before;
      expect(before.map((w) => w.name)).toEqual(['Dana Ortiz']);
      // the active recruiter is NOT duplicated into the historical set.
      expect(before.map((w) => w.user_id)).not.toContain('u-2');
      expect(v.relationship.ownership.also_working_with.map((a) => a.user_id)).toEqual(['u-2']);
    });

    it('§9.5 surfaces the authoritative terminal reason on a closed opportunity; absent ⇒ null ("reason not recorded")', async () => {
      const service = svc(
        fakePort({
          listEpisodes: async () => [
            episode('pipe-2', 'req-2', 'not_in_consideration'), // reason present
            episode('pipe-3', 'req-3', 'completed'), // no disposition reason
          ],
          resolveRequisitions: async () =>
            new Map([
              ['req-2', req('req-2', 1002)],
              ['req-3', req('req-3', 1003)],
            ]),
          // reason ONLY for pipe-2 — pipe-3 is absent from the map.
          resolveDispositionReasons: async () => new Map([['pipe-2', 'CLIENT_PASSED']]),
        }),
      );
      const v = await service.compose(ctx(), 'tal-1', NOW, TZ);
      const closed = v.opportunities!.closed;
      expect(closed.find((c) => c.pipeline_id === 'pipe-2')!.reason).toBe('CLIENT_PASSED');
      expect(closed.find((c) => c.pipeline_id === 'pipe-3')!.reason).toBeNull();
    });
  });
});

function docRow(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'd-1',
    title: 'file.docx',
    document_type_key: 'RESUME',
    document_type_name: 'Résumé',
    status: 'DRAFT',
    executed_at: null,
    created_at: '2026-09-14T00:00:00Z',
    regarding_requisition_id: null,
    ...overrides,
  };
}
