import { describe, expect, it, vi } from 'vitest';

import {
  buildSeedPlan,
  legalPathTo,
  seed,
  type SeedPorts,
} from './seed-e2e-data.lib';

const CTX = { tenantId: 'tenant-9', recruiterUserId: 'user-r', tag: 'E2E ' };

function fakePorts(overrides: Partial<SeedPorts> = {}): SeedPorts {
  let n = 0;
  const id = () => ({ id: `id-${(n += 1)}` });
  return {
    hasTaggedRequisition: vi.fn().mockResolvedValue(false),
    createCompany: vi.fn().mockResolvedValue(id()),
    createContact: vi.fn().mockResolvedValue(id()),
    createRequisition: vi.fn().mockResolvedValue(id()),
    assignRequisition: vi.fn().mockResolvedValue(undefined),
    createTalent: vi.fn().mockResolvedValue(id()),
    createPipeline: vi.fn().mockResolvedValue(id()),
    transitionPipeline: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue(id()),
    createActivity: vi.fn().mockResolvedValue(id()),
    createEngagement: vi.fn().mockResolvedValue(id()),
    ...overrides,
  };
}

describe('buildSeedPlan', () => {
  const plan = buildSeedPlan('E2E ');

  it('is generic staffing data — NOT the mockup people/titles', () => {
    const blob = JSON.stringify(plan);
    for (const banned of ['Marcus', 'Adeyemi', 'Sofia', 'Ramos', 'Senior Rust Engineer']) {
      expect(blob).not.toContain(banned);
    }
  });

  it('everything is tag-prefixed (removable)', () => {
    expect(plan.companies.every((c) => c.name.startsWith('E2E '))).toBe(true);
    expect(plan.requisitions.every((r) => r.external_req_id.startsWith('E2E '))).toBe(true);
    expect(plan.talent.length).toBeGreaterThanOrEqual(8);
    expect(plan.requisitions.length).toBeGreaterThanOrEqual(3);
  });

  it('has a hot and a plain requisition (for Only-hot/Only-mine filters)', () => {
    expect(plan.requisitions.some((r) => r.is_hot)).toBe(true);
    expect(plan.requisitions.some((r) => !r.is_hot)).toBe(true);
  });

  it('the pipeline spans multiple stages incl. placed + a terminal (funnel coverage)', () => {
    const stages = new Set(plan.pipelines.map((p) => p.status));
    expect(stages.has('placed')).toBe(true);
    expect(stages.has('not_in_consideration')).toBe(true);
    expect(stages.size).toBeGreaterThanOrEqual(4);
  });

  it('carries NO rating or structured per-pipeline rate (R10 / gap #1/#3)', () => {
    const blob = JSON.stringify(plan);
    expect(blob).not.toMatch(/rating|stars|rate_amount|pay_rate/i);
    // pipeline specs are status-only (no rate/rating keys).
    for (const p of plan.pipelines) {
      expect(Object.keys(p).sort()).toEqual(['requisitionKey', 'status', 'talentKey']);
    }
  });
});

describe('seed orchestration', () => {
  it('creates entities in dependency order and ASSIGNS every requisition to the recruiter (visibility)', async () => {
    const ports = fakePorts();
    const plan = buildSeedPlan('E2E ');
    const report = await seed(ports, CTX, plan);

    expect(report.status).toBe('seeded');
    expect(ports.createCompany).toHaveBeenCalledTimes(plan.companies.length);
    expect(ports.createRequisition).toHaveBeenCalledTimes(plan.requisitions.length);
    // CRITICAL: one assignment per requisition, to the test recruiter.
    expect(ports.assignRequisition).toHaveBeenCalledTimes(plan.requisitions.length);
    expect(ports.assignRequisition).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-9', userId: 'user-r' }),
    );
    expect(ports.createTalent).toHaveBeenCalledTimes(plan.talent.length);
    expect(ports.createPipeline).toHaveBeenCalledTimes(plan.pipelines.length);
    // Stages are reached by walking the legal state machine (real transitions),
    // not set at create — so non-no_contact pipelines drive transitions.
    expect(ports.transitionPipeline).toHaveBeenCalled();
    expect(ports.createEngagement).toHaveBeenCalledOnce();
    expect(report.requisition_ids).toHaveLength(plan.requisitions.length);
    expect(report.talent_ids.length).toBeGreaterThanOrEqual(8);
  });

  it('legalPathTo walks the real state machine (no illegal jumps)', () => {
    expect(legalPathTo('no_contact')).toEqual([]);
    expect(legalPathTo('qualifying')).toEqual(['contacted', 'talent_responded', 'qualifying']);
    expect(legalPathTo('placed')).toEqual([
      'contacted', 'talent_responded', 'qualifying', 'submitted', 'interviewing', 'offered', 'placed',
    ]);
    expect(legalPathTo('not_in_consideration')).toEqual(['not_in_consideration']);
  });

  it('is idempotent — a prior tagged requisition skips re-seeding', async () => {
    const ports = fakePorts({ hasTaggedRequisition: vi.fn().mockResolvedValue(true) });
    const report = await seed(ports, CTX, buildSeedPlan('E2E '));
    expect(report.status).toBe('already_seeded');
    expect(ports.createCompany).not.toHaveBeenCalled();
    expect(ports.createRequisition).not.toHaveBeenCalled();
  });
});
