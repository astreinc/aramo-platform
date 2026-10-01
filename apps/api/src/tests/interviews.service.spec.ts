import { describe, expect, it, vi } from 'vitest';

import type {
  CalendarSessionRow,
  InterviewsActorContext,
  InterviewsReadPort,
  RequisitionLabel,
} from '../interviews/interviews.ports.js';
import { InterviewsService } from '../interviews/interviews.service.js';

// Unit proofs for the interview-calendar composition (Slice A, Calendar/Interview §6).
// The service depends only on the InterviewsReadPort, so enrichment + short-circuit
// behaviour is proven with in-memory fakes (no Testcontainers). The lib read
// (window/visibility/filters) is proven separately in libs/client-selection
// interview-session.integration.spec.ts (F2-CAL).

const CTX: InterviewsActorContext = {
  tenant_id: 't1',
  user_id: 'u1',
  visibility: {} as InterviewsActorContext['visibility'],
  visible_requisition_ids: null,
};

function session(over: Partial<CalendarSessionRow> = {}): CalendarSessionRow {
  return {
    id: 's1',
    scheduled_at: '2026-10-05T15:00:00.000Z',
    scheduled_end_at: null,
    timezone: null,
    state: 'SCHEDULED',
    round: 1,
    interview_type: 'video',
    talent_record_id: 'tal1',
    requisition_id: 'req1',
    interviewer_user_ids: ['ivr1'],
    version: 0,
    ...over,
  };
}

function makePort(over: Partial<InterviewsReadPort> = {}): InterviewsReadPort {
  return {
    listCalendarSessions: vi.fn(async () => []),
    resolveTalentNames: vi.fn(async () => new Map<string, string>()),
    resolveRequisitionLabels: vi.fn(
      async () => new Map<string, RequisitionLabel>(),
    ),
    resolveCompanyNames: vi.fn(async () => new Map<string, string>()),
    ...over,
  };
}

const filters = {
  from: new Date('2026-10-01T00:00:00.000Z'),
  to: new Date('2026-10-10T00:00:00.000Z'),
};

describe('InterviewsService.listCalendar', () => {
  it('short-circuits on an empty window — echoes the window and issues NO enrichment reads', async () => {
    const port = makePort();
    const svc = new InterviewsService(port);

    const out = await svc.listCalendar(CTX, filters);

    expect(out.interviews).toEqual([]);
    expect(out.window).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-10T00:00:00.000Z',
    });
    expect(port.resolveTalentNames).not.toHaveBeenCalled();
    expect(port.resolveRequisitionLabels).not.toHaveBeenCalled();
    expect(port.resolveCompanyNames).not.toHaveBeenCalled();
  });

  it('enriches each session with Talent name, requisition ref/title, and company name', async () => {
    const port = makePort({
      listCalendarSessions: vi.fn(async () => [
        session({ id: 's1', talent_record_id: 'tal1', requisition_id: 'req1' }),
        session({
          id: 's2',
          talent_record_id: 'tal2',
          requisition_id: 'req2',
          scheduled_at: '2026-10-06T09:00:00.000Z',
          state: 'CANCELED',
        }),
      ]),
      resolveTalentNames: vi.fn(
        async () =>
          new Map([
            ['tal1', 'Ada Lovelace'],
            ['tal2', 'Alan Turing'],
          ]),
      ),
      resolveRequisitionLabels: vi.fn(
        async () =>
          new Map<string, RequisitionLabel>([
            ['req1', { requisition_number: 100, title: 'Backend Eng', company_id: 'co1' }],
            ['req2', { requisition_number: 200, title: 'Data Eng', company_id: 'co2' }],
          ]),
      ),
      resolveCompanyNames: vi.fn(
        async () =>
          new Map([
            ['co1', 'Acme'],
            ['co2', 'Globex'],
          ]),
      ),
    });
    const svc = new InterviewsService(port);

    const out = await svc.listCalendar(CTX, filters);

    expect(out.interviews).toHaveLength(2);
    expect(out.interviews[0]).toMatchObject({
      id: 's1',
      talent_name: 'Ada Lovelace',
      requisition_number: 100,
      requisition_title: 'Backend Eng',
      company_id: 'co1',
      company_name: 'Acme',
      state: 'SCHEDULED',
      version: 0,
    });
    expect(out.interviews[1]).toMatchObject({
      id: 's2',
      talent_name: 'Alan Turing',
      requisition_number: 200,
      company_name: 'Globex',
      state: 'CANCELED',
    });
    // company names resolved only for the distinct non-null company ids present.
    expect(port.resolveCompanyNames).toHaveBeenCalledWith(CTX, ['co1', 'co2']);
  });

  it('renders explicit nulls when an enrichment lookup is missing (never fabricates)', async () => {
    const port = makePort({
      listCalendarSessions: vi.fn(async () => [
        session({ id: 's1', talent_record_id: 'tal1', requisition_id: 'reqX' }),
      ]),
      // no talent name; requisition label absent → all derived fields null.
      resolveTalentNames: vi.fn(async () => new Map<string, string>()),
      resolveRequisitionLabels: vi.fn(async () => new Map<string, RequisitionLabel>()),
    });
    const svc = new InterviewsService(port);

    const out = await svc.listCalendar(CTX, filters);

    expect(out.interviews[0]).toMatchObject({
      id: 's1',
      talent_name: null,
      requisition_number: null,
      requisition_title: null,
      company_id: null,
      company_name: null,
    });
    // no company ids to resolve.
    expect(port.resolveCompanyNames).toHaveBeenCalledWith(CTX, []);
  });
});
