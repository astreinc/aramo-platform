import { describe, expect, it } from 'vitest';

import { MyDeskService } from './my-desk.service.js';
import type {
  DeskActorContext,
  DeskAwaitingRow,
  DeskBlockedPlacementRow,
  DeskInterviewRow,
  DeskOfferRow,
  DeskRequisitionRow,
  DeskTaskRow,
  MyDeskReadPort,
} from './my-desk.ports.js';

const TZ = 'America/New_York';
const NOW = Date.parse('2026-09-29T16:00:00Z'); // Tue Sep 29, midday EDT

const CTX: DeskActorContext = {
  tenant_id: 't-1',
  user_id: 'u-1',
  visibility: {
    tenant_id: 't-1',
    actor_user_id: 'u-1',
    see_all_company: false,
    see_all_requisition: false,
    visible_client_ids: null,
  },
  visible_requisition_ids: new Set(['req-1', 'req-2']),
  visible_contact_ids: null,
};

// A configurable in-memory port. Every list defaults to empty so each test
// declares only what it exercises.
function fakePort(overrides: Partial<MyDeskReadPort> = {}): MyDeskReadPort {
  const base: MyDeskReadPort = {
    listMyTasks: async () => [],
    listMyRequisitions: async () => [],
    countsForRequisitions: async () => new Map(),
    activeRequisitionsByTalent: async () => new Map(),
    listInterviewsInWindow: async () => [],
    listAwaitingClient: async () => [],
    listBlockedPlacements: async () => [],
    listExpiringOffers: async () => [],
    resolveTalentNames: async () => new Map(),
    resolveCompanyNames: async () => new Map(),
  };
  return { ...base, ...overrides };
}

function task(over: Partial<DeskTaskRow> & { id: string }): DeskTaskRow {
  return {
    id: over.id,
    title: over.title ?? 'A task',
    due_date: over.due_date ?? null,
    type: over.type ?? null,
    owner_type: over.owner_type ?? 'requisition',
    owner_id: over.owner_id ?? 'req-1',
  };
}

describe('MyDeskService.compose — header metadata (§38)', () => {
  it('emits the app-timezone civil date, not the UTC date', async () => {
    const svc = new MyDeskService(fakePort());
    const view = await svc.compose(CTX, Date.parse('2026-09-30T02:00:00Z'), TZ);
    // 2026-09-30T02:00Z = Sep 29 22:00 EDT → civil Sep 29 locally.
    expect(view.server_date).toBe('2026-09-29');
    expect(view.generated_at).toBe('2026-09-30T02:00:00.000Z');
  });
});

describe('MyDeskService.compose — priority queue from tasks', () => {
  it('classifies urgency against the app timezone and orders overdue→today→upcoming', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyTasks: async () => [
          task({ id: 'c', due_date: '2026-10-02T12:00:00Z', owner_type: 'requisition', owner_id: 'req-1' }),
          task({ id: 'a', due_date: '2026-09-27T12:00:00Z', owner_type: 'requisition', owner_id: 'req-1' }),
          task({ id: 'b', due_date: '2026-09-29T20:00:00Z', owner_type: 'requisition', owner_id: 'req-1' }),
        ],
      }),
    );
    const view = await svc.compose(CTX, NOW, TZ);
    expect(view.priority_items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(view.priority_items.map((i) => i.urgency)).toEqual([
      'overdue',
      'today',
      'upcoming',
    ]);
  });

  it('uses the resolved talent name as the label for a talent-owned task', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyTasks: async () => [
          task({
            id: 't1',
            title: 'Call back about hybrid days',
            type: 'call',
            owner_type: 'talent_record',
            owner_id: 'tal-9',
            due_date: '2026-09-29T18:00:00Z',
          }),
        ],
        resolveTalentNames: async () => new Map([['tal-9', 'Sofia Alvarez']]),
      }),
    );
    const [item] = (await svc.compose(CTX, NOW, TZ)).priority_items;
    expect(item.kind).toBe('follow_up');
    expect(item.label).toBe('Sofia Alvarez');
    expect(item.talent_id).toBe('tal-9');
    expect(item.reason).toBe('Call back about hybrid days');
    expect(item.primary_action).toEqual({
      kind: 'open_task',
      label: 'Open task',
      href: '/talent/tal-9',
    });
  });

  it('falls back to the task title as the label for a requisition-owned task and sets the req label', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyTasks: async () => [
          task({ id: 't2', title: 'Send prep notes', type: 'admin', owner_type: 'requisition', owner_id: 'req-1' }),
        ],
        listMyRequisitions: async () => [reqRow({ id: 'req-1', requisition_number: 1001 })],
      }),
    );
    const [item] = (await svc.compose(CTX, NOW, TZ)).priority_items;
    expect(item.label).toBe('Send prep notes');
    expect(item.requisition_id).toBe('req-1');
    expect(item.requisition_label).toBe('REQ-1001');
    expect(item.primary_action?.href).toBe('/requisitions/req-1');
  });

  it('enriches a talent-owned task with its requisition when the talent has ONE active pipeline', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyTasks: async () => [
          task({ id: 't3', title: 'Log call', type: 'call', owner_type: 'talent_record', owner_id: 'tal-1' }),
        ],
        listMyRequisitions: async () => [reqRow({ id: 'req-1', requisition_number: 1001 })],
        activeRequisitionsByTalent: async () => new Map([['tal-1', ['req-1']]]),
        resolveTalentNames: async () => new Map([['tal-1', 'Kevin Brooks']]),
      }),
    );
    const [item] = (await svc.compose(CTX, NOW, TZ)).priority_items;
    expect(item.talent_name).toBe('Kevin Brooks');
    expect(item.requisition_id).toBe('req-1');
    expect(item.requisition_label).toBe('REQ-1001');
  });

  it('does NOT guess requisition context when the talent has multiple active pipelines (ambiguous → null)', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyTasks: async () => [
          task({ id: 't4', title: 'Log call', type: 'call', owner_type: 'talent_record', owner_id: 'tal-2' }),
        ],
        listMyRequisitions: async () => [
          reqRow({ id: 'req-1', requisition_number: 1001 }),
          reqRow({ id: 'req-2', requisition_number: 1004 }),
        ],
        activeRequisitionsByTalent: async () => new Map([['tal-2', ['req-1', 'req-2']]]),
        resolveTalentNames: async () => new Map([['tal-2', 'Marcus Lee']]),
      }),
    );
    const [item] = (await svc.compose(CTX, NOW, TZ)).priority_items;
    expect(item.requisition_id).toBeNull();
    expect(item.requisition_label).toBeNull();
  });
});

function reqRow(over: Partial<DeskRequisitionRow> & { id: string }): DeskRequisitionRow {
  return {
    id: over.id,
    requisition_number: over.requisition_number ?? 1001,
    title: over.title ?? 'A requisition',
    company_id: over.company_id ?? 'co-1',
    status: over.status ?? 'open',
    created_at: over.created_at ?? '2026-09-13T12:00:00Z',
    is_hot: over.is_hot ?? false,
  };
}

describe('MyDeskService.compose — my requisitions table', () => {
  it('projects company name, days-open, and ALL counts from the groupBy projection (incl. real downstream)', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyRequisitions: async () => [
          reqRow({ id: 'req-1', requisition_number: 1001, title: 'BA', company_id: 'co-1', created_at: '2026-09-13T12:00:00Z' }),
        ],
        countsForRequisitions: async (_ctx, reqIds) => {
          expect(reqIds).toEqual(['req-1']); // exactly the visible reqs, no 200-row load
          return new Map([
            ['req-1', { pipeline: 3, qualified: 2, with_client: 1, offer: 1, started: 0 }],
          ]);
        },
        resolveCompanyNames: async () => new Map([['co-1', 'Freddie Mac']]),
      }),
    );
    const [row] = (await svc.compose(CTX, NOW, TZ)).requisitions;
    expect(row.code).toBe('REQ-1001');
    expect(row.client_name).toBe('Freddie Mac');
    expect(row.days_open).toBe(16); // Sep 13 → Sep 29
    expect(row.pipeline_count).toBe(3);
    expect(row.qualified_count).toBe(2);
    // Increment-2: downstream counts are now REAL (no longer hardcoded 0).
    expect(row.with_client_count).toBe(1);
    expect(row.offer_count).toBe(1);
    expect(row.started_count).toBe(0);
  });

  it('signal surfaces the most-advanced non-zero stage', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyRequisitions: async () => [reqRow({ id: 'req-1', requisition_number: 1001 })],
        countsForRequisitions: async () =>
          new Map([['req-1', { pipeline: 5, qualified: 2, with_client: 1, offer: 1, started: 1 }]]),
      }),
    );
    const [row] = (await svc.compose(CTX, NOW, TZ)).requisitions;
    expect(row.signal).toBe('1 started');
  });

  it('a requisition with no counts row renders zeros and the sourcing signal', async () => {
    const svc = new MyDeskService(
      fakePort({
        listMyRequisitions: async () => [reqRow({ id: 'req-9', requisition_number: 1009 })],
        countsForRequisitions: async () => new Map(),
      }),
    );
    const [row] = (await svc.compose(CTX, NOW, TZ)).requisitions;
    expect(row.pipeline_count).toBe(0);
    expect(row.with_client_count).toBe(0);
    expect(row.signal).toBe('No pipeline yet');
  });
});

describe('MyDeskService.compose — today’s interviews (§38 day boundary)', () => {
  it('includes scheduled sessions in the local day and excludes canceled', async () => {
    const interviews: DeskInterviewRow[] = [
      { id: 'iv-1', scheduled_at: '2026-09-29T15:00:00Z', talent_record_id: 'tal-1', requisition_id: 'req-1', interview_type: 'client_interview', round: 1, state: 'SCHEDULED' },
      { id: 'iv-2', scheduled_at: '2026-09-29T18:30:00Z', talent_record_id: 'tal-2', requisition_id: 'req-2', interview_type: 'recruiter_screen', round: 1, state: 'CANCELED' },
    ];
    const svc = new MyDeskService(
      fakePort({
        listInterviewsInWindow: async () => interviews,
        listMyRequisitions: async () => [reqRow({ id: 'req-1', requisition_number: 1001 })],
        resolveTalentNames: async () => new Map([['tal-1', 'Rahul Nair']]),
      }),
    );
    const view = await svc.compose(CTX, NOW, TZ);
    expect(view.interviews_today.map((i) => i.id)).toEqual(['iv-1']);
    const [iv] = view.interviews_today;
    expect(iv.talent_name).toBe('Rahul Nair');
    expect(iv.requisition_label).toBe('REQ-1001');
    expect(iv.round).toBe(1);
    // The substrate has no talent-confirmation field — honest 'unknown'.
    expect(iv.confirmation).toBe('unknown');
  });
});

describe('MyDeskService.compose — awaiting client (oldest first)', () => {
  it('ages against the app timezone and orders oldest first', async () => {
    const rows: DeskAwaitingRow[] = [
      { id: 'w-new', talent_id: 'tal-a', requisition_id: 'req-1', created_at: '2026-09-24T12:00:00Z' },
      { id: 'w-old', talent_id: 'tal-b', requisition_id: 'req-2', created_at: '2026-09-21T12:00:00Z' },
    ];
    const svc = new MyDeskService(
      fakePort({
        listAwaitingClient: async () => rows,
        resolveTalentNames: async () => new Map([['tal-b', 'Kiran Rao'], ['tal-a', 'Emily Carter']]),
      }),
    );
    const view = await svc.compose(CTX, NOW, TZ);
    expect(view.awaiting_client.map((w) => w.id)).toEqual(['w-old', 'w-new']);
    expect(view.awaiting_client[0]).toMatchObject({
      talent_name: 'Kiran Rao',
      waiting_days: 8, // Sep 21 → Sep 29
    });
  });
});

describe('MyDeskService.compose — exceptions', () => {
  it('surfaces blocked pre-start (high) and expiring offers (medium), high first', async () => {
    const blocked: DeskBlockedPlacementRow[] = [
      { id: 'pl-1', talent_record_id: 'tal-x', requisition_id: 'req-1', proposed_start_date: '2026-10-06' },
    ];
    const offers: DeskOfferRow[] = [
      { id: 'of-1', talent_record_id: 'tal-y', requisition_id: 'req-1', state: 'SENT', offer_expires_at: '2026-10-02T12:00:00Z' },
      { id: 'of-2', talent_record_id: 'tal-z', requisition_id: 'req-2', state: 'ACCEPTED', offer_expires_at: '2026-10-02T12:00:00Z' }, // not expiring-relevant
      { id: 'of-3', talent_record_id: 'tal-w', requisition_id: 'req-2', state: 'SENT', offer_expires_at: '2026-12-01T12:00:00Z' }, // too far out
    ];
    const svc = new MyDeskService(
      fakePort({
        listBlockedPlacements: async () => blocked,
        listExpiringOffers: async () => offers,
        resolveTalentNames: async () =>
          new Map([['tal-x', 'Samuel Ortiz'], ['tal-y', 'Liam OConnor']]),
      }),
    );
    const view = await svc.compose(CTX, NOW, TZ);
    expect(view.exceptions.map((x) => x.kind)).toEqual([
      'pre_start_blocked',
      'offer_expiring',
    ]);
    expect(view.exceptions[0]).toMatchObject({
      severity: 'high',
      title: 'Pre-Start blocked · Samuel Ortiz',
      requisition_id: 'req-1',
    });
    expect(view.exceptions[1]).toMatchObject({
      severity: 'medium',
      kind: 'offer_expiring',
    });
  });
});
