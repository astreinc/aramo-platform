import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { SourcingController } from '../talent-identity/sourcing.controller.js';

const ROOT = resolve(__dirname, '../../../..');

// ADR-0024 PR-3b — the SOURCING command boundary gates REQUISITION_TALENT · ADD.
// These cover the threading + the negative invariant the HTTP E2E cannot reach
// structurally: PipelineRepository.create (via the service) is NEVER reached
// from this path without a policy decision, and the provenance the engine
// produced is the one that flows onward.

const TENANT = '11111111-1111-7111-8111-111111111111';
const AUTH = { tenant_id: TENANT, sub: 'actor-1', scopes: ['talent:source'] } as never;
const DTO = { ref_type: 'SOURCED_TALENT', ref_id: 'payload-1', requisition_id: 'req-1' } as never;

const PROVENANCE = {
  tenant_id: TENANT,
  decision: 'ALLOW',
  policy_version: '1.0.0',
  rule_id: 'add-talent-active',
  reason_code: 'LIFECYCLE_ADD_ALLOWED',
  resource: 'REQUISITION_TALENT',
  action: 'ADD',
  inputs: { resource: 'REQUISITION_TALENT', action: 'ADD', declared: {}, derived: {}, capabilities: {} },
  actor_id: 'actor-1',
  origin: 'ui',
  correlation_id: 'req-id-1',
};

function make(over: { allowed?: boolean; serviceResult?: unknown } = {}) {
  // PR-4b — the outcome is now disposition-based (ALLOW/DENY/REQUIRES_OVERRIDE);
  // these unit cases cover the ALLOW/DENY threading, so map the boolean to a
  // disposition. (The REQUIRES_OVERRIDE two-pass is covered by
  // override-resolution.spec.ts + the policy-override E2E.)
  const decide = vi.fn().mockResolvedValue({
    disposition: (over.allowed ?? true) ? 'ALLOW' : 'DENY',
    reason_code: PROVENANCE.reason_code,
    required_capabilities: [],
    provenance: PROVENANCE,
  });
  const promoteAndAddToPipeline = vi.fn().mockResolvedValue(
    over.serviceResult ?? { status: 'promoted', talent_record_id: 'rec-1', pipeline_id: 'pipe-1' },
  );
  const recordDecision = vi.fn().mockResolvedValue(undefined);
  const controller = new SourcingController(
    { promoteAndAddToPipeline } as never,
    { decide } as never,
    { recordDecision } as never,
  );
  return { controller, decide, promoteAndAddToPipeline, recordDecision };
}

describe('SourcingController.addToPipeline — policy gate', () => {
  it('ALLOW + mutation → threads the SAME provenance to the service; NO standalone write (it committed in-tx)', async () => {
    const { controller, decide, promoteAndAddToPipeline, recordDecision } = make();
    await controller.addToPipeline(AUTH, DTO, 'req-id-1');
    expect(decide).toHaveBeenCalledTimes(1);
    const call = promoteAndAddToPipeline.mock.calls[0]!;
    expect(call[1]).toBe('req-1'); // requisition_id
    // L2-B — the controller now also threads the birth-history actor (authContext.sub).
    expect(call[2]).toEqual({ provenance: PROVENANCE, created_by_id: 'actor-1' });
    expect((call[2] as { provenance: unknown }).provenance).toBe(PROVENANCE); // same object
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('ALLOW + deferral (no pipeline row) → provenance recorded STANDALONE with the ALLOW decision', async () => {
    const { controller, promoteAndAddToPipeline, recordDecision } = make({
      serviceResult: { status: 'deferred_unknown_subject' },
    });
    await controller.addToPipeline(AUTH, DTO, 'req-id-1');
    expect(promoteAndAddToPipeline).toHaveBeenCalledTimes(1); // service WAS invoked (ALLOW)
    expect(recordDecision).toHaveBeenCalledWith(PROVENANCE); // standalone, decision stays ALLOW
    expect(PROVENANCE.decision).toBe('ALLOW');
  });

  it('DENY → 403 POLICY_DENIED (reason_code only), service NEVER invoked (no promotion), provenance standalone', async () => {
    const { controller, promoteAndAddToPipeline, recordDecision } = make({ allowed: false });
    await expect(controller.addToPipeline(AUTH, DTO, 'req-id-1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      statusCode: 403,
    });
    expect(promoteAndAddToPipeline).not.toHaveBeenCalled(); // ruling 4: no promotion
    expect(recordDecision).toHaveBeenCalledWith(PROVENANCE);
  });

  it('DENY 403 leaks reason_code ONLY — no rule_id / policy_version', async () => {
    const { controller } = make({ allowed: false });
    let thrown: AramoError | undefined;
    try {
      await controller.addToPipeline(AUTH, DTO, 'req-id-1');
    } catch (e) {
      thrown = e as AramoError;
    }
    const body = JSON.stringify(thrown?.context ?? {});
    expect(body).toContain('LIFECYCLE_ADD_ALLOWED'); // the reason_code (from the fixture)
    expect(body).not.toContain('add-talent-active'); // rule_id
    expect(body).not.toContain('1.0.0'); // policy_version
  });

  it('NEGATIVE INVARIANT — the service (→ create) is only ever reached AFTER a decision, always WITH provenance', async () => {
    // ALLOW: reached, with provenance.
    const allow = make();
    await allow.controller.addToPipeline(AUTH, DTO, 'req-id-1');
    for (const c of allow.promoteAndAddToPipeline.mock.calls) {
      expect((c[2] as { provenance?: unknown }).provenance).toBe(PROVENANCE);
      expect((c[2] as { provenance?: unknown }).provenance).not.toBeUndefined();
    }
    // DENY: never reached.
    const deny = make({ allowed: false });
    await deny.controller.addToPipeline(AUTH, DTO, 'req-id-1').catch(() => undefined);
    expect(deny.promoteAndAddToPipeline).not.toHaveBeenCalled();
  });
});

describe('BOTH BOUNDARIES structural — create() unreachable without a decision', () => {
  const pipelineCtl = readFileSync(resolve(ROOT, 'libs/pipeline/src/lib/pipeline.controller.ts'), 'utf8');
  const sourcingCtl = readFileSync(resolve(ROOT, 'apps/api/src/talent-identity/sourcing.controller.ts'), 'utf8');
  const pipelineRepo = readFileSync(resolve(ROOT, 'libs/pipeline/src/lib/pipeline.repository.ts'), 'utf8');

  it('BOTH command boundaries call the policy decision before the write', () => {
    // Boundary 1 — PipelineController.create (PR-3).
    expect(pipelineCtl).toContain('addTalentPolicy.decide(');
    // Boundary 2 — SourcingController.addToPipeline (PR-3b).
    expect(sourcingCtl).toContain('addTalentPolicy.decide(');
  });

  it('the ONLY paths to PipelineRepository.create() are the two gated controllers; the merge-fold uses raw INSERT (ungated by design)', () => {
    // repointTalentRecordRefs (identity-merge reconciliation) must NOT be
    // recruiter-policy-gated — it reaches Pipeline rows via raw INSERT, never
    // create(), so no policy decision is (or should be) required.
    expect(pipelineRepo).toContain('INSERT INTO "pipeline"."Pipeline"');
    expect(pipelineRepo).toContain('repointTalentRecordRefs');
  });
});
