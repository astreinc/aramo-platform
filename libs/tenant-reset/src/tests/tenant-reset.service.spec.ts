import { describe, expect, it } from 'vitest';

import type { ArchiveSink } from '../lib/archive.js';
import type { PgExec } from '../lib/pg-exec.js';
import type { RecordResetBatchInput } from '../lib/reset-batch.js';
import {
  TenantResetService,
  TenantAssertionError,
  RerunRefusedError,
  ArchiveLocationRequiredError,
  ACTIVITY_SCOPE_PREDICATE,
  type ResetBatchRecorder,
  type ResetOptions,
} from '../lib/tenant-reset.service.js';

// Track-0 §6 — the deliverable is trust. These specs exercise the engine
// against a fake executor (no DB), proving the safety guarantees:
//   - dry run mutates NOTHING (no BEGIN/LOCK/DELETE/COMMIT issued);
//   - a wrong tenant id refuses with no partial work;
//   - an archive checksum mismatch aborts BEFORE any delete;
//   - a completed real run refuses a re-run unless overridden;
//   - the delete order is §2.2 exactly (child-before-parent);
//   - a real run without an archive location refuses.
// The preserve/scope INVARIANTS against real Postgres live in the apps/api
// integration spec.

const TENANT = '01900000-0000-7000-8000-0000000000f1';
const REQ = '01900000-0000-7000-8000-0000000000f2';
const PIPE = '01900000-0000-7000-8000-0000000000f3';

interface FakeOpts {
  tenantExists?: boolean;
  reqIds?: string[];
  pipeIds?: string[];
  // archiveRows keyed by entity label; the before-count of a deleted entity
  // is derived from its archive row count so archive-verify counts match.
  archiveRows?: Record<string, Array<Record<string, unknown>>>;
  preservedCounts?: Record<string, number>;
  usageColumns?: string[];
  usageCount?: number;
}

// A recording pg.Client-shaped fake. Tracks whether a DELETE has run so the
// post-delete recount returns zero.
class FakePg implements PgExec {
  readonly log: Array<{ sql: string; params?: unknown[] }> = [];
  private deletedRan = false;

  constructor(private readonly o: FakeOpts) {}

  get statements(): string[] {
    return this.log.map((l) => l.sql.trim().replace(/\s+/g, ' '));
  }
  get deletes(): string[] {
    return this.statements.filter((s) => s.startsWith('DELETE FROM'));
  }
  has(prefixOrPart: string): boolean {
    return this.statements.some((s) => s.includes(prefixOrPart));
  }

  private labelFrom(sql: string): string | null {
    const m = /FROM\s+([a-z_]+\."[A-Za-z]+")/.exec(sql);
    return m ? m[1] : null;
  }

  async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
    this.log.push({ sql, params });
    const s = sql.trim();
    const one = (n: number): { rows: T[]; rowCount: number | null } => ({
      rows: [{ n } as unknown as T],
      rowCount: 1,
    });

    if (/^(BEGIN|COMMIT|ROLLBACK|LOCK TABLE)/.test(s)) return { rows: [], rowCount: 0 };
    if (/^DELETE FROM/.test(s)) {
      this.deletedRan = true;
      return { rows: [], rowCount: 0 };
    }
    if (/FROM identity\."Tenant"/.test(s)) return one(this.o.tenantExists === false ? 0 : 1);
    if (/SELECT id FROM requisition\."Requisition"/.test(s))
      return { rows: (this.o.reqIds ?? []).map((id) => ({ id })) as unknown as T[], rowCount: null };
    if (/SELECT id FROM pipeline\."Pipeline"/.test(s))
      return { rows: (this.o.pipeIds ?? []).map((id) => ({ id })) as unknown as T[], rowCount: null };
    if (/information_schema\.columns/.test(s)) {
      const cols = this.o.usageColumns ?? ['id', 'tenant_id', 'event_type', 'quantity', 'occurred_at'];
      return { rows: cols.map((c) => ({ column_name: c })) as unknown as T[], rowCount: null };
    }
    if (/count\(\*\)::int AS n FROM metering\."UsageEvent"/.test(s)) return one(this.o.usageCount ?? 0);

    if (/^SELECT count\(\*\)::int AS n FROM/.test(s)) {
      const label = this.labelFrom(s);
      // Preserved activity is disambiguated by its NOT IN predicate.
      const isPreservedActivity = /NOT IN \('requisition','pipeline'\)/.test(s);
      if (label !== null && !isPreservedActivity && this.o.archiveRows?.[label] !== undefined) {
        // deleted-entity count: before = archive rows; after = 0.
        return one(this.deletedRan ? 0 : (this.o.archiveRows[label]?.length ?? 0));
      }
      // preserved-entity count (constant before and after).
      const key = isPreservedActivity ? `activity."Activity" (talent/company/contact history)` : (label ?? '');
      return one(this.o.preservedCounts?.[key] ?? 0);
    }

    if (/^SELECT \* FROM/.test(s)) {
      const label = this.labelFrom(s);
      return {
        rows: (label !== null ? (this.o.archiveRows?.[label] ?? []) : []) as unknown as T[],
        rowCount: null,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

// An in-memory recorder; captures every appended batch.
class FakeRecorder implements ResetBatchRecorder {
  readonly appended: RecordResetBatchInput[] = [];
  constructor(private readonly prior: { id: string } | null = null) {}
  async record(input: RecordResetBatchInput): Promise<{ id: string }> {
    this.appended.push(input);
    return { id: `batch-${this.appended.length}` };
  }
  async findCompletedRealRun(): Promise<{ id: string } | null> {
    return this.prior;
  }
}

// A faithful in-memory archive sink (write then read returns the same bytes).
class MemSink implements ArchiveSink {
  store = new Map<string, string>();
  async write(location: string, bytes: string): Promise<void> {
    this.store.set(location, bytes);
  }
  async read(location: string): Promise<string> {
    return this.store.get(location) ?? '';
  }
}

// A tampering sink: read returns different bytes than written → checksum
// mismatch on VERIFY ARCHIVE (§3.6).
class TamperSink implements ArchiveSink {
  async write(): Promise<void> {
    /* pretend to persist */
  }
  async read(): Promise<string> {
    return '{"tampered":true}';
  }
}

const baseOpts = (over: Partial<ResetOptions> = {}): ResetOptions => ({
  tenantId: TENANT,
  approvedBy: 'Purush (PO)',
  executionCommit: 'deadbeef',
  now: () => new Date('2026-08-01T00:00:00.000Z'),
  ...over,
});

const richDb = (): FakeOpts => ({
  tenantExists: true,
  reqIds: [REQ],
  pipeIds: [PIPE],
  archiveRows: {
    'activity."Activity"': [{ id: 'a1', subject_type: 'pipeline' }],
    'requisition."RequisitionLifecycleEvent"': [{ id: 'e1' }],
    'submittal."TalentSubmittalEvent"': [{ id: 'se1' }],
    'submittal."TalentSubmittalRecord"': [{ id: 'sr1' }],
    'engagement."TalentEngagementEvent"': [{ id: 'ee1' }],
    'engagement."TalentJobEngagement"': [{ id: 'je1' }],
    'pipeline."PipelineStatusHistory"': [{ id: 'ph1' }],
    'pipeline."Pipeline"': [{ id: PIPE }],
    'requisition."RequisitionAssignment"': [{ id: 'ra1' }],
    'requisition."Requisition"': [{ id: REQ }],
  },
  preservedCounts: {
    'metering."UsageEvent"': 7,
    'consent."TalentConsentEvent"': 3,
    'talent_record."TalentRecord"': 5,
    'company."Company"': 2,
    'contact."Contact"': 4,
    'identity."Tenant"': 1,
    'activity."Activity" (talent/company/contact history)': 6,
  },
  usageColumns: ['id', 'tenant_id', 'event_type', 'quantity', 'occurred_at'],
  usageCount: 7,
});

describe('TenantResetService — dry run (§3.2)', () => {
  it('mutates NOTHING — issues no BEGIN/LOCK/DELETE/COMMIT/ROLLBACK', async () => {
    const pg = new FakePg(richDb());
    const rec = new FakeRecorder();
    const svc = new TenantResetService(rec, new MemSink());

    const report = await svc.dryRun(pg, baseOpts());

    expect(report.result).toBe('COMPLETED');
    expect(report.mode).toBe('dry-run');
    for (const forbidden of ['BEGIN', 'COMMIT', 'ROLLBACK', 'LOCK TABLE', 'DELETE FROM']) {
      expect(pg.has(forbidden)).toBe(false);
    }
    // A dry run records a batch too (§2.1), with dry_run=true and no archive.
    expect(rec.appended).toHaveLength(1);
    expect(rec.appended[0]!.dry_run).toBe(true);
    expect(rec.appended[0]!.result).toBe('COMPLETED');
    expect(rec.appended[0]!.archive_location).toBeNull();
    // The preview checksum is present (proves the export path without writing).
    expect(report.archive_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(report.archive_location).toBeNull();
  });

  it('reports the exact Activity scoping predicate (§2.3)', async () => {
    const pg = new FakePg(richDb());
    const svc = new TenantResetService(new FakeRecorder(), new MemSink());
    const report = await svc.dryRun(pg, baseOpts());
    expect(report.activity_predicate).toBe(ACTIVITY_SCOPE_PREDICATE);
    // The predicate never targets talent/company/contact history.
    expect(report.activity_predicate).not.toContain('talent_record');
    expect(report.activity_predicate).toContain("subject_type = 'requisition'");
    expect(report.activity_predicate).toContain("subject_type = 'pipeline'");
  });

  it('surfaces the UsageEvent snapshot-field divergence but stays explainable', async () => {
    const pg = new FakePg(richDb());
    const svc = new TenantResetService(new FakeRecorder(), new MemSink());
    const report = await svc.dryRun(pg, baseOpts());
    // The substrate lacks every enumerated snapshot field — reported, not fatal.
    expect(report.usage_event_check.missing_snapshot_fields).toEqual(
      expect.arrayContaining(['actor', 'channel', 'billing_key', 'requisition_id', 'pipeline_id', 'correlation_id']),
    );
    expect(report.usage_event_check.dangling_refs).toBe(0);
    expect(report.usage_event_check.explainable).toBe(true);
  });
});

describe('TenantResetService — tenant assertion (§3.1 / §4 / §6)', () => {
  it('refuses a malformed tenant id with no partial work', async () => {
    const pg = new FakePg(richDb());
    const svc = new TenantResetService(new FakeRecorder(), new MemSink());
    await expect(svc.execute(pg, baseOpts({ tenantId: 'not-a-uuid', archiveLocation: '/tmp/a' }))).rejects.toBeInstanceOf(
      TenantAssertionError,
    );
    expect(pg.has('BEGIN')).toBe(false);
    expect(pg.deletes).toEqual([]);
  });

  it('refuses a non-existent tenant with no partial work', async () => {
    const pg = new FakePg({ ...richDb(), tenantExists: false });
    const svc = new TenantResetService(new FakeRecorder(), new MemSink());
    await expect(svc.execute(pg, baseOpts({ archiveLocation: '/tmp/a' }))).rejects.toBeInstanceOf(
      TenantAssertionError,
    );
    expect(pg.has('BEGIN')).toBe(false);
    expect(pg.deletes).toEqual([]);
  });
});

describe('TenantResetService — real run gates (§3.5-3.8, §4)', () => {
  it('requires an explicit archive location before any freeze', async () => {
    const pg = new FakePg(richDb());
    const svc = new TenantResetService(new FakeRecorder(), new MemSink());
    await expect(svc.execute(pg, baseOpts())).rejects.toBeInstanceOf(ArchiveLocationRequiredError);
    expect(pg.has('BEGIN')).toBe(false);
  });

  it('refuses a re-run after a completed real run, unless overridden (§4)', async () => {
    const pg = new FakePg(richDb());
    const rec = new FakeRecorder({ id: 'prior-batch' });
    const svc = new TenantResetService(rec, new MemSink());
    await expect(svc.execute(pg, baseOpts({ archiveLocation: '/tmp/a' }))).rejects.toBeInstanceOf(
      RerunRefusedError,
    );
    expect(pg.deletes).toEqual([]);

    // With an explicit override + new approval, it proceeds.
    const pg2 = new FakePg(richDb());
    const svc2 = new TenantResetService(new FakeRecorder({ id: 'prior' }), new MemSink());
    const report = await svc2.execute(pg2, baseOpts({ archiveLocation: '/tmp/a', overrideCompletedRun: true }));
    expect(report.result).toBe('COMPLETED');
  });

  it('ABORTS before any delete on an archive checksum mismatch (§3.6)', async () => {
    const pg = new FakePg(richDb());
    const rec = new FakeRecorder();
    const svc = new TenantResetService(rec, new TamperSink());
    const report = await svc.execute(pg, baseOpts({ archiveLocation: '/tmp/a' }));

    expect(report.result).toBe('ABORTED');
    expect(report.archive_verified).toBe(false);
    // The freeze engaged (BEGIN + LOCK) but NO delete ran, and it rolled back.
    expect(pg.has('BEGIN')).toBe(true);
    expect(pg.has('LOCK TABLE')).toBe(true);
    expect(pg.deletes).toEqual([]);
    expect(pg.has('ROLLBACK')).toBe(true);
    expect(pg.has('COMMIT')).toBe(false);
    // An abort leaves a trace (§2.1).
    expect(rec.appended).toHaveLength(1);
    expect(rec.appended[0]!.result).toBe('ABORTED');
    expect(rec.appended[0]!.dry_run).toBe(false);
  });
});

describe('TenantResetService — happy path + delete ordering (§2.2 / §3.8)', () => {
  it('deletes in §2.2 order, child-before-parent, then COMMITs COMPLETED', async () => {
    const pg = new FakePg(richDb());
    const rec = new FakeRecorder();
    const svc = new TenantResetService(rec, new MemSink());

    const report = await svc.execute(pg, baseOpts({ archiveLocation: '/tmp/archive.json' }));

    expect(report.result).toBe('COMPLETED');
    expect(report.archive_verified).toBe(true);
    expect(report.freeze_engaged).toBe(true);
    expect(report.freeze_released).toBe(true);
    expect(pg.has('COMMIT')).toBe(true);
    expect(pg.has('ROLLBACK')).toBe(false);

    // The DELETE order is the binding §2.2 order, children first.
    const expectedOrder = [
      'DELETE FROM activity."Activity"',
      'DELETE FROM requisition."RequisitionLifecycleEvent"',
      'DELETE FROM submittal."TalentSubmittalEvent"',
      'DELETE FROM submittal."TalentSubmittalRecord"',
      'DELETE FROM engagement."TalentEngagementEvent"',
      'DELETE FROM engagement."TalentJobEngagement"',
      'DELETE FROM pipeline."PipelineStatusHistory"',
      'DELETE FROM pipeline."Pipeline"',
      'DELETE FROM requisition."RequisitionAssignment"',
      'DELETE FROM requisition."Requisition"',
      // PR-15 — the internal-number allocator is cleared so a reset tenant
      // restarts at REQ-1000.
      'DELETE FROM requisition."RequisitionNumberSequence"',
      // §2.2.7 (T0 v1.1) — E2 pre-start, FK-safe: Audit → Instance → Definition
      // → MaterializationIntent → Set.
      'DELETE FROM pre_start_requirement."PreStartRequirementAudit"',
      'DELETE FROM pre_start_requirement."PreStartRequirementInstance"',
      'DELETE FROM pre_start_requirement."PreStartRequirementDefinition"',
      'DELETE FROM pre_start_requirement."PreStartMaterializationIntent"',
      'DELETE FROM pre_start_requirement."PreStartRequirementSet"',
      // §2.2.8 (PR-C) — placement aggregate, FK-safe + trigger-aware:
      // OutboxEvent → PlacementProcessEvent (Restrict child) → AssignmentRateVersion
      // (Track 5 / T5-P1, child-before-parent, delete-reject escape) → ContractAssignment
      // (Track 4 / T4-F, child-before-parent) → PlacementProcess.
      'DELETE FROM placement."OutboxEvent"',
      'DELETE FROM placement."PlacementProcessEvent"',
      'DELETE FROM placement."AssignmentRateVersion"',
      'DELETE FROM placement."ContractAssignment"',
      'DELETE FROM placement."PlacementProcess"',
    ];
    expect(pg.deletes.map((d) => d.split(' WHERE ')[0])).toEqual(expectedOrder);

    // The freeze (LOCK) is engaged before the first delete.
    const stmts = pg.statements;
    const lockIdx = stmts.findIndex((s) => s.startsWith('LOCK TABLE'));
    const firstDeleteIdx = stmts.findIndex((s) => s.startsWith('DELETE FROM'));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(firstDeleteIdx);

    // COMPLETED batch records before + after counts, archive + checksum.
    expect(rec.appended).toHaveLength(1);
    const batch = rec.appended[0]!;
    expect(batch.result).toBe('COMPLETED');
    expect(batch.dry_run).toBe(false);
    expect(batch.archive_location).toBe('/tmp/archive.json');
    expect(batch.archive_checksum).toMatch(/^[0-9a-f]{64}$/);
    // Preserved counts are recorded before AND after (identical).
    for (const [, c] of Object.entries(batch.rows_by_entity.preserved)) {
      expect(c.after).toBe(c.before);
    }
    // Deleted counts go to zero after.
    for (const [, c] of Object.entries(batch.rows_by_entity.deleted)) {
      expect(c.after).toBe(0);
    }
  });
});
