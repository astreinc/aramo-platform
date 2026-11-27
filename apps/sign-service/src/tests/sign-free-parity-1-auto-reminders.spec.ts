import 'reflect-metadata';
import { AUTO_REMINDER_DAY_MS } from '@aramo/sign-client';
import { EsignService, ReminderLimitError } from '@aramo/sign';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EsignAutoReminderWorker, autoReminderIntervalMs, autoReminderWorkerEnabled } from '../app/esign-auto-reminder.worker.js';

// SIGN-FREE-PARITY-1 S4 (FP-R5) — automatic reminders: the engine's compare-and-set send, the
// sender's switch, the send-time planning, and the opt-in worker.

const NOW = new Date('2026-11-29T10:00:00.000Z');
const SENT_AT = new Date('2026-11-27T10:00:00.000Z');
const PLANNED = new Date('2026-11-29T10:00:00.000Z');

type Row = {
  auto_reminders_enabled: boolean;
  auto_reminder_count: number;
  next_auto_reminder_at: Date | null;
  send_risk_verdict: string | null;
  envelope_mode: string;
  routing_mode: string;
  sent_at: Date | null;
};

function rowOf(over: Partial<Row> = {}): Row {
  return {
    auto_reminders_enabled: true,
    auto_reminder_count: 0,
    next_auto_reminder_at: PLANNED,
    send_risk_verdict: 'ALLOWED',
    envelope_mode: 'STANDARD',
    routing_mode: 'PARALLEL',
    sent_at: SENT_AT,
    ...over,
  };
}

// The signing engine with only the parts these paths read (prisma + repo).
function engine(opts: { status?: string; row?: Row; signers?: unknown[]; events?: unknown[]; revision?: number } = {}) {
  const row = opts.row ?? rowOf();
  const updates: Array<Record<string, unknown>> = [];
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const appended: Array<Record<string, unknown>> = [];
  const sessionsCreated: unknown[] = [];
  const tx = {
    signer: {
      findMany: async () => opts.signers ?? [{ id: 's1', status: 'PENDING', signing_order: 1, recipient_kind: 'SIGNER', witness_for_signer_id: null }],
    },
    signatureEnvelope: {
      findFirstOrThrow: async () => row,
      update: async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        return {};
      },
    },
    signatureEvent: { findMany: async () => opts.events ?? [] },
    signingSession: { updateMany: async () => ({}), create: async (a: unknown) => sessionsCreated.push(a) },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx), signatureEnvelope: { updateMany, findMany: vi.fn(async () => []) } };
  const svc = Object.create(EsignService.prototype) as EsignService;
  Object.assign(svc, {
    prisma,
    repo: {
      lockEnvelope: async () => opts.status ?? 'SENT',
      lockEnvelopeRevision: async (_tx: unknown, _t: string, _e: string, expected?: number) => {
        if (expected !== undefined && expected !== (opts.revision ?? 3)) throw new Error('revision mismatch');
        return { status: opts.status ?? 'SENT', revision: opts.revision ?? 3 };
      },
      appendEvent: async (_tx: unknown, input: Record<string, unknown>) => {
        appended.push(input);
        return 'ev';
      },
    },
  });
  return { svc, updates, updateMany, appended, sessionsCreated, prisma };
}

describe('EsignService.sendAutoReminder', () => {
  it('sends: replaces the signer link, marks the event automatic (system actor), counts it and plans the next in 3 days', async () => {
    const e = engine();
    const r = await e.svc.sendAutoReminder('t', 'e', PLANNED, NOW);
    expect(r.outcome).toEqual({ kind: 'sent', sent_count: 1, next_at: new Date(NOW.getTime() + 3 * AUTO_REMINDER_DAY_MS) });
    expect(r.sessions).toHaveLength(1);
    expect(e.sessionsCreated).toHaveLength(1);
    expect(e.appended[0]).toMatchObject({ event_type: 'SIGNATURE_REMINDER_SENT', actor_type: 'SYSTEM', payload: { signer_ids: ['s1'], automatic: true } });
    expect(e.appended[0]).not.toHaveProperty('actor_ref');
    expect(e.updates.at(-1)).toEqual({ auto_reminder_count: 1, next_auto_reminder_at: new Date(NOW.getTime() + 3 * AUTO_REMINDER_DAY_MS) });
  });

  it('the fifth one plans no more', async () => {
    const e = engine({ row: rowOf({ auto_reminder_count: 4 }) });
    const r = await e.svc.sendAutoReminder('t', 'e', PLANNED, NOW);
    expect(r.outcome).toEqual({ kind: 'sent', sent_count: 5, next_at: null });
  });

  it('compare-and-set: a plan that moved (another process, or the sender) is skipped and sends nothing', async () => {
    for (const row of [rowOf({ next_auto_reminder_at: new Date(PLANNED.getTime() + 1) }), rowOf({ next_auto_reminder_at: null }), rowOf({ auto_reminders_enabled: false })]) {
      const e = engine({ row });
      const r = await e.svc.sendAutoReminder('t', 'e', PLANNED, NOW);
      expect(r).toEqual({ outcome: { kind: 'skipped' }, sessions: [] });
      expect(e.appended).toHaveLength(0);
      expect(e.updates).toHaveLength(0);
    }
  });

  it.each([
    ['COMPLETED', rowOf(), 'envelope status COMPLETED'],
    ['DECLINED', rowOf(), 'envelope status DECLINED'],
    ['VOIDED', rowOf(), 'envelope status VOIDED'],
    ['EXPIRED', rowOf(), 'envelope status EXPIRED'],
    ['SENT', rowOf({ auto_reminder_count: 5 }), 'max_reached'],
    ['SENT', rowOf({ envelope_mode: 'SELF' }), 'self_sign'],
    ['SENT', rowOf({ send_risk_verdict: null }), 'no_send_verdict'],
  ] as const)('%s → stops (%s)', async (status, row, reason) => {
    const e = engine({ status, row });
    const r = await e.svc.sendAutoReminder('t', 'e', PLANNED, NOW);
    expect(r.outcome).toEqual({ kind: 'stopped', reason });
    expect(e.appended).toHaveLength(0);
    expect(e.updates).toEqual([{ next_auto_reminder_at: null }]);
  });

  it('reuses the send-time verdict: a Business (NOT_GATED) send is reminded with no further check', async () => {
    const e = engine({ row: rowOf({ send_risk_verdict: 'NOT_GATED' }) });
    expect((await e.svc.sendAutoReminder('t', 'e', PLANNED, NOW)).outcome.kind).toBe('sent');
  });

  it('counts against the reminder limits: a sender reminder 10 minutes ago moves the plan to the cooldown end, uncounted', async () => {
    const recent = new Date(NOW.getTime() - 10 * 60_000);
    const e = engine({ events: [{ occurred_at: recent, payload: { signer_ids: ['s1'] } }] });
    const r = await e.svc.sendAutoReminder('t', 'e', PLANNED, NOW);
    const retry = new Date(recent.getTime() + 60 * 60_000);
    expect(r.outcome).toEqual({ kind: 'rescheduled', next_at: retry, reason: 'reminder_cooldown' });
    expect(e.updateMany).toHaveBeenCalledWith({
      where: { id: 'e', tenant_id: 't', next_auto_reminder_at: PLANNED, auto_reminders_enabled: true },
      data: { next_auto_reminder_at: retry },
    });
    expect(e.appended).toHaveLength(0);
    expect(ReminderLimitError).toBeDefined();
  });

  it('no one to remind right now (sequential in-person turn): tries again in 3 days, uncounted', async () => {
    const e = engine({
      row: rowOf({ routing_mode: 'SEQUENTIAL' }),
      signers: [{ id: 'p1', status: 'PENDING', signing_order: 1, recipient_kind: 'IN_PERSON_SIGNER', witness_for_signer_id: null }],
    });
    const r = await e.svc.sendAutoReminder('t', 'e', PLANNED, NOW);
    expect(r.outcome).toMatchObject({ kind: 'rescheduled', reason: 'no_one_to_remind_now', next_at: new Date(NOW.getTime() + 3 * AUTO_REMINDER_DAY_MS) });
  });
});

describe('EsignService.setAutoReminders', () => {
  it('turned off after sending: nothing more is planned', async () => {
    const e = engine();
    await e.svc.setAutoReminders('t', 'e', false, {}, NOW);
    expect(e.updates).toEqual([{ auto_reminders_enabled: false, next_auto_reminder_at: null }]);
  });

  it('turned on after sending: the plain cadence time, or now when it has passed', async () => {
    const soon = engine({ row: rowOf({ auto_reminders_enabled: false }) });
    await soon.svc.setAutoReminders('t', 'e', true, {}, new Date(SENT_AT.getTime() + AUTO_REMINDER_DAY_MS));
    expect(soon.updates).toEqual([{ auto_reminders_enabled: true, next_auto_reminder_at: new Date(SENT_AT.getTime() + 2 * AUTO_REMINDER_DAY_MS) }]);
    const late = engine({ row: rowOf({ auto_reminders_enabled: false, auto_reminder_count: 1 }) });
    const at = new Date(SENT_AT.getTime() + 9 * AUTO_REMINDER_DAY_MS);
    await late.svc.setAutoReminders('t', 'e', true, {}, at);
    expect(late.updates).toEqual([{ auto_reminders_enabled: true, next_auto_reminder_at: at }]);
  });

  it('while drafting: only the switch (planning happens at send)', async () => {
    const e = engine({ status: 'DRAFT', row: rowOf({ sent_at: null, send_risk_verdict: null, next_auto_reminder_at: null }) });
    await e.svc.setAutoReminders('t', 'e', true, {}, NOW);
    expect(e.updates).toEqual([{ auto_reminders_enabled: true, next_auto_reminder_at: null }]);
  });

  it('turned on with no recorded send verdict (sent before S4) or all 5 sent: on, nothing planned', async () => {
    for (const row of [rowOf({ send_risk_verdict: null }), rowOf({ auto_reminder_count: 5 })]) {
      const e = engine({ row });
      await e.svc.setAutoReminders('t', 'e', true, {}, NOW);
      expect(e.updates).toEqual([{ auto_reminders_enabled: true, next_auto_reminder_at: null }]);
    }
  });

  it.each(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'])('refused once %s', async (status) => {
    await expect(engine({ status }).svc.setAutoReminders('t', 'e', false, {}, NOW)).rejects.toMatchObject({ name: 'ReminderNotAllowedError' });
  });

  it('refused for a self-signed envelope, and on a stale If-Match', async () => {
    await expect(engine({ row: rowOf({ envelope_mode: 'SELF' }) }).svc.setAutoReminders('t', 'e', true, {}, NOW)).rejects.toMatchObject({ name: 'ReminderNotAllowedError' });
    await expect(engine({ revision: 3 }).svc.setAutoReminders('t', 'e', true, { expected_revision: 2 }, NOW)).rejects.toThrow(/revision/);
  });
});

describe('EsignService.dueAutoReminders', () => {
  it('reads open, switched-on envelopes whose plan is due, oldest first', async () => {
    const e = engine();
    e.prisma.signatureEnvelope.findMany.mockResolvedValueOnce([{ id: 'e1', tenant_id: 't1', next_auto_reminder_at: PLANNED }] as never);
    expect(await e.svc.dueAutoReminders(NOW, 10)).toEqual([{ tenant_id: 't1', envelope_id: 'e1', planned_at: PLANNED }]);
    expect(e.prisma.signatureEnvelope.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['SENT', 'IN_PROGRESS'] }, auto_reminders_enabled: true, next_auto_reminder_at: { lte: NOW } },
      orderBy: { next_auto_reminder_at: 'asc' },
      take: 10,
      select: { id: true, tenant_id: true, next_auto_reminder_at: true },
    });
  });
});

describe('EsignAutoReminderWorker', () => {
  afterEach(() => {
    delete process.env['SIGN_AUTO_REMINDER_WORKER_ENABLED'];
    delete process.env['SIGN_AUTO_REMINDER_INTERVAL_MS'];
  });

  it('is off unless SIGN_AUTO_REMINDER_WORKER_ENABLED=1; the interval has a 60 s floor', () => {
    expect(autoReminderWorkerEnabled({})).toBe(false);
    expect(autoReminderWorkerEnabled({ SIGN_AUTO_REMINDER_WORKER_ENABLED: '0' })).toBe(false);
    expect(autoReminderWorkerEnabled({ SIGN_AUTO_REMINDER_WORKER_ENABLED: '1' })).toBe(true);
    expect(autoReminderIntervalMs({})).toBe(300_000);
    expect(autoReminderIntervalMs({ SIGN_AUTO_REMINDER_INTERVAL_MS: '120000' })).toBe(120_000);
    expect(autoReminderIntervalMs({ SIGN_AUTO_REMINDER_INTERVAL_MS: '1000' })).toBe(300_000);
    expect(autoReminderIntervalMs({ SIGN_AUTO_REMINDER_INTERVAL_MS: 'x' })).toBe(300_000);
  });

  it('does not schedule when off; schedules when on', async () => {
    const off = new EsignAutoReminderWorker({} as never);
    off.onApplicationBootstrap();
    expect(off.scheduled).toBe(false);
    process.env['SIGN_AUTO_REMINDER_WORKER_ENABLED'] = '1';
    const on = new EsignAutoReminderWorker({} as never);
    on.onApplicationBootstrap();
    expect(on.scheduled).toBe(true);
    await on.onApplicationShutdown();
    expect(on.scheduled).toBe(false);
  });

  it('one tick sends each due envelope through the provider and tallies the outcomes; a failure is left for the next tick', async () => {
    const due = [
      { tenant_id: 't', envelope_id: 'a', planned_at: PLANNED },
      { tenant_id: 't', envelope_id: 'b', planned_at: PLANNED },
      { tenant_id: 't', envelope_id: 'c', planned_at: PLANNED },
      { tenant_id: 't', envelope_id: 'd', planned_at: PLANNED },
    ];
    const outcomes: Record<string, unknown> = {
      a: { kind: 'sent', sent_count: 1, next_at: null },
      b: { kind: 'rescheduled', next_at: NOW, reason: 'reminder_cooldown' },
      c: { kind: 'skipped' },
    };
    const provider = {
      dueAutoReminders: vi.fn(async () => due),
      sendAutoReminder: vi.fn(async (_t: string, id: string) => {
        if (id === 'd') throw new Error('db down');
        return outcomes[id];
      }),
    };
    const worker = new EsignAutoReminderWorker(provider as never);
    expect(await worker.tick(NOW)).toEqual({ sent: 1, rescheduled: 1, stopped: 0, skipped: 1, failed: 1 });
    expect(provider.dueAutoReminders).toHaveBeenCalledWith(NOW, 50);
    expect(provider.sendAutoReminder).toHaveBeenCalledWith('t', 'a', PLANNED, NOW);
  });

  it('overlap latch: a tick while one runs does nothing', async () => {
    let release: () => void = () => undefined;
    const provider = {
      dueAutoReminders: vi.fn(() => new Promise<never[]>((r) => (release = () => r([])))),
      sendAutoReminder: vi.fn(),
    };
    const worker = new EsignAutoReminderWorker(provider as never);
    const first = worker.tick(NOW);
    expect(await worker.tick(NOW)).toEqual({ sent: 0, rescheduled: 0, stopped: 0, skipped: 0, failed: 0 });
    release();
    await first;
    expect(provider.dueAutoReminders).toHaveBeenCalledTimes(1);
  });
});
