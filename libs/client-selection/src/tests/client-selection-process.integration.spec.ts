import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { ClientSelectionProcessRepository } from '../lib/client-selection.repository.js';

// Lane 2 / L2-F (F1) — the ClientSelectionProcess owner acceptance proofs (charter
// F1.1–F1.3 + CAS + legality + 404-concealment + append-only immutability). The
// schema is self-contained (UUID-only Submittal link, no cross-schema FK), so this
// applies ONLY the client_selection migration. Every criterion carries a non-vacuous
// BEFORE/AFTER (Rule F).
const MIGRATIONS = [
  '../../prisma/migrations/20260829120000_l2f_init_client_selection/migration.sql',
].map((p) => resolve(__dirname, p));

// Dollar-quote- AND line-comment-aware DDL splitter (the migration carries $$ trigger
// bodies + `--` prose lines).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-F F1 ClientSelectionProcess (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let repo: ClientSelectionProcessRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new PrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          if (s.trim()) await setup.$executeRawUnsafe(s.trim());
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ClientSelectionProcessRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setup?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedProcess(tenant: string, req: string, actor?: string) {
      return repo.create({
        tenant_id: tenant,
        submittal_id: randomUUID(),
        requisition_id: req,
        talent_id: randomUUID(),
        site_id: randomUUID(),
        ...(actor === undefined ? {} : { created_by_id: actor }),
      });
    }

    async function eventRows(processId: string) {
      return prisma.clientSelectionEvent.findMany({
        where: { subject_id: processId },
        orderBy: { created_at: 'asc' },
      });
    }

    // ----------------------------------------------------------------------
    // F1.1 — owner exists, UUID-linked, birth event + outbox.
    // ----------------------------------------------------------------------
    it('F1.1: create yields a CLIENT_REVIEW process UUID-linked to the Submittal, with a birth event + outbox', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const submittal = randomUUID();
      const actor = randomUUID();

      const created = await repo.create({
        tenant_id: tenant,
        submittal_id: submittal,
        requisition_id: req,
        talent_id: randomUUID(),
        site_id: randomUUID(),
        created_by_id: actor,
      });
      expect(created.state).toBe('CLIENT_REVIEW');
      expect(created.submittal_id).toBe(submittal);
      expect(created.requisition_id).toBe(req);
      expect(created.version).toBe(0);

      // Birth event + outbox, each exactly one.
      const events = await eventRows(created.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('client_selection.process.created');
      expect(events[0]!.subject_type).toBe('process');
      const outbox = await prisma.outboxEvent.findMany({ where: { tenant_id: tenant } });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.event_type).toBe('client_selection.process.created');
      expect(outbox[0]!.published_at).toBeNull();
    });

    // F1.1 negative control — one process per Submittal (unique link).
    it('F1.1(neg): a second process for the same Submittal is refused CLIENT_SELECTION_SUBMITTAL_INVALID (409)', async () => {
      const tenant = randomUUID();
      const submittal = randomUUID();
      await repo.create({ tenant_id: tenant, submittal_id: submittal, requisition_id: randomUUID(), talent_id: randomUUID() });
      await expect(
        repo.create({ tenant_id: tenant, submittal_id: submittal, requisition_id: randomUUID(), talent_id: randomUUID() }),
      ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_SUBMITTAL_INVALID', statusCode: 409 });
    });

    // ----------------------------------------------------------------------
    // F1.2 — CAS concurrency.
    // ----------------------------------------------------------------------
    it('F1.2: two transitions with the same expected_version — one commits (+1), one conflicts, no extra event', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      expect(p.version).toBe(0);

      const results = await Promise.allSettled([
        repo.transition({ tenant_id: tenant, id: p.id, to_state: 'INTERVIEW', expected_version: 0, changed_by_id: randomUUID(), requestId: 'a', visible_requisition_ids: null }),
        repo.transition({ tenant_id: tenant, id: p.id, to_state: 'SELECTED', expected_version: 0, changed_by_id: randomUUID(), requestId: 'b', visible_requisition_ids: null }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(bad[0]!.reason?.code).toBe('CLIENT_SELECTION_TRANSITION_CONFLICT');

      const after = await repo.findById({ tenant_id: tenant, id: p.id, visible_requisition_ids: null });
      expect(after!.version).toBe(1); // exactly one commit
      // birth + exactly one transition event.
      expect(await eventRows(p.id)).toHaveLength(2);
    });

    // ----------------------------------------------------------------------
    // Legality — illegal transition refused 422; terminal is terminal.
    // ----------------------------------------------------------------------
    it('legality: SELECTED is terminal; a transition out of it is INVALID_CLIENT_SELECTION_TRANSITION (422)', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const sel = await repo.transition({ tenant_id: tenant, id: p.id, to_state: 'SELECTED', expected_version: 0, changed_by_id: randomUUID(), requestId: 's', visible_requisition_ids: null });
      expect(sel.state).toBe('SELECTED');
      await expect(
        repo.transition({ tenant_id: tenant, id: p.id, to_state: 'DECLINED', expected_version: sel.version, changed_by_id: randomUUID(), requestId: 's2', visible_requisition_ids: null }),
      ).rejects.toMatchObject({ code: 'INVALID_CLIENT_SELECTION_TRANSITION', statusCode: 422 });
    });

    // L3-E (P3) — WITHDRAWN/DECLINED provenance: the immutable transition event records
    // WHO acted (changed_by_id) + the structured cause (reason_code), so materially
    // different withdrawal causes are distinguishable, never collapsed.
    it('L3-E: a WITHDRAWN transition persists actor + structured reason_code in the immutable event', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const actor = randomUUID();
      const p = await seedProcess(tenant, req);
      const w = await repo.transition({
        tenant_id: tenant,
        id: p.id,
        to_state: 'WITHDRAWN',
        expected_version: 0,
        changed_by_id: actor,
        reason_code: 'client_withdrew',
        note: 'client paused the role',
        requestId: 'w',
        visible_requisition_ids: null,
      });
      expect(w.state).toBe('WITHDRAWN');
      const events = await prisma.clientSelectionEvent.findMany({
        where: {
          subject_id: p.id,
          subject_type: 'process',
          event_type: 'client_selection.process.state_transition',
        },
      });
      expect(events).toHaveLength(1);
      const payload = events[0]!.event_payload as Record<string, unknown>;
      expect(payload['changed_by_id']).toBe(actor);
      expect(payload['reason_code']).toBe('client_withdrew');
      expect(payload['note']).toBe('client paused the role');
      expect(payload['to_state']).toBe('WITHDRAWN');
    }, 60_000);

    // ----------------------------------------------------------------------
    // Visibility 404-concealment.
    // ----------------------------------------------------------------------
    it('concealment: a transition whose requisition is outside the visible set is 404 (not 403), unmutated', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const otherReqOnly = new Set<string>([randomUUID()]); // excludes p.requisition_id
      await expect(
        repo.transition({ tenant_id: tenant, id: p.id, to_state: 'INTERVIEW', expected_version: 0, changed_by_id: randomUUID(), requestId: 'v', visible_requisition_ids: otherReqOnly }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      const after = await repo.findById({ tenant_id: tenant, id: p.id, visible_requisition_ids: null });
      expect(after!.state).toBe('CLIENT_REVIEW'); // unmutated
    });

    // ----------------------------------------------------------------------
    // F1.3 — append-only event immutability (DB triggers) + tenant-reset escape.
    // ----------------------------------------------------------------------
    it('F1.3: a committed event rejects UPDATE + DELETE; the tenant-reset escape may DELETE', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const ev = (await eventRows(p.id))[0]!;

      await expect(
        prisma.$executeRawUnsafe(`UPDATE client_selection."ClientSelectionEvent" SET event_type = 'x' WHERE id = '${ev.id}'`),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM client_selection."ClientSelectionEvent" WHERE id = '${ev.id}'`),
      ).rejects.toThrow();
      expect(await eventRows(p.id)).toHaveLength(1); // unchanged

      await prisma.$executeRawUnsafe(
        `DO $do$ BEGIN PERFORM set_config('app.tenant_reset', 'authorized', true); ` +
          `DELETE FROM client_selection."ClientSelectionEvent" WHERE id = '${ev.id}'; END $do$;`,
      );
      expect(await eventRows(p.id)).toHaveLength(0);
    });
  },
);
