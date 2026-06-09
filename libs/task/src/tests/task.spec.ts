import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import type { AuthContextType } from '@aramo/auth';
import type { VisibilityContextShape } from '@aramo/common';

import { TaskController } from '../lib/task.controller.js';
import type { TaskRepository } from '../lib/task.repository.js';
import {
  buildTaskVisibilityWhere,
  isOwnerVisible,
  type TaskVisibilityInputs,
} from '../lib/task.repository.js';
import type { TaskAssigneeValidator } from '../lib/task-assignee.port.js';

// Tasks backend proofs. Lead rulings: R1 async-irrelevant (sync CRUD) · R2
// binary status · R4 create-time 404 assert · R5 active-within-tenant assignee
// · R6 owner immutable · R7 hard delete · contact-resolver completes the 4
// owner_types. Unit-level (the activity/talent-record substrate norm).

const TENANT = '01900000-0000-7000-8000-000000000001';
const ACTOR = '01900000-0000-7000-8000-0000000000aa';
const REQUIRED_SCOPES_KEY = 'aramo:authorization:required_scopes';

function makeAuth(scopes: string[]): AuthContextType {
  return {
    sub: ACTOR,
    tenant_id: TENANT,
    scopes,
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

// A scoped actor: sees company co-1, requisition req-1, contact ct-1 only.
function scopedVis(): {
  visibility: VisibilityContextShape;
  reqIds: ReadonlySet<string>;
  contactIds: ReadonlySet<string>;
} {
  return {
    visibility: {
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      see_all_company: false,
      see_all_requisition: false,
      visible_client_ids: new Set(['co-1']),
    },
    reqIds: new Set(['req-1']),
    contactIds: new Set(['ct-1']),
  };
}

function makeReq(v: ReturnType<typeof scopedVis>): Request {
  return {
    resolveVisibility: async () => v.visibility,
    resolveVisibleRequisitionIds: async () => v.reqIds,
    resolveVisibleContactIds: async () => v.contactIds,
  } as unknown as Request;
}

function makeController(opts?: { assigneeOk?: boolean }): {
  ctl: TaskController;
  repo: {
    create: ReturnType<typeof vi.fn>;
    findByIdForActor: ReturnType<typeof vi.fn>;
    listForAssignee: ReturnType<typeof vi.fn>;
    listForOwner: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  assignee: { isActiveTenantMember: ReturnType<typeof vi.fn> };
} {
  const repo = {
    create: vi.fn().mockResolvedValue({ id: 't1' }),
    findByIdForActor: vi.fn().mockResolvedValue({ id: 't1' }),
    listForAssignee: vi.fn().mockResolvedValue([]),
    listForOwner: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ id: 't1' }),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const assignee = {
    isActiveTenantMember: vi.fn().mockResolvedValue(opts?.assigneeOk ?? true),
  };
  const ctl = new TaskController(
    repo as unknown as TaskRepository,
    assignee as unknown as TaskAssigneeValidator,
  );
  return { ctl, repo, assignee };
}

// ---------------------------------------------------------------------------
// PROOF — visibility-AND: the polymorphic OR composes all 4 owner_types,
// including the NEW contact branch.
// ---------------------------------------------------------------------------
describe('Tasks proof — visibility-AND (buildTaskVisibilityWhere)', () => {
  it('scoped actor → 4-branch OR (talent pool-open; req/company/contact IN-sets)', () => {
    const v = scopedVis();
    const inputs: TaskVisibilityInputs = {
      visibility: v.visibility,
      visible_requisition_ids: v.reqIds,
      visible_contact_ids: v.contactIds,
    };
    const where = buildTaskVisibilityWhere(inputs) as { OR: Array<Record<string, unknown>> };
    expect(where.OR).toEqual([
      { owner_type: 'talent_record' },
      { owner_type: 'requisition', owner_id: { in: ['req-1'] } },
      { owner_type: 'company', owner_id: { in: ['co-1'] } },
      { owner_type: 'contact', owner_id: { in: ['ct-1'] } },
    ]);
  });

  it('see-all (company + requisition) → no visibility filter ({})', () => {
    const where = buildTaskVisibilityWhere({
      visibility: {
        tenant_id: TENANT,
        actor_user_id: ACTOR,
        see_all_company: true,
        see_all_requisition: true,
        visible_client_ids: null,
      },
      visible_requisition_ids: null,
      visible_contact_ids: null,
    });
    expect(where).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// PROOF — create-time link-target assert (isOwnerVisible → controller 404).
// ---------------------------------------------------------------------------
describe('Tasks proof — isOwnerVisible (the 4 owner_types)', () => {
  const v = scopedVis();
  const inputs: TaskVisibilityInputs = {
    visibility: v.visibility,
    visible_requisition_ids: v.reqIds,
    visible_contact_ids: v.contactIds,
  };
  it('talent_record is always visible (pool-open)', () => {
    expect(isOwnerVisible('talent_record', 'any', inputs)).toBe(true);
  });
  it('requisition / company / contact gate on their visible sets', () => {
    expect(isOwnerVisible('requisition', 'req-1', inputs)).toBe(true);
    expect(isOwnerVisible('requisition', 'req-2', inputs)).toBe(false);
    expect(isOwnerVisible('company', 'co-1', inputs)).toBe(true);
    expect(isOwnerVisible('company', 'co-2', inputs)).toBe(false);
    expect(isOwnerVisible('contact', 'ct-1', inputs)).toBe(true);
    expect(isOwnerVisible('contact', 'ct-2', inputs)).toBe(false);
  });
});

describe('Tasks proof — create-time 404 assert (controller)', () => {
  it('create on a NON-visible requisition → 404 NOT_FOUND, repo.create not called', async () => {
    const { ctl, repo } = makeController();
    const v = scopedVis();
    await expect(
      ctl.create(
        makeAuth(['task:write']),
        { title: 'Call', owner_type: 'requisition', owner_id: 'req-2' },
        'rq-1',
        makeReq(v),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('create on a visible contact → repo.create called', async () => {
    const { ctl, repo } = makeController();
    await ctl.create(
      makeAuth(['task:write']),
      { title: 'Email', owner_type: 'contact', owner_id: 'ct-1' },
      'rq-1',
      makeReq(scopedVis()),
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT,
        created_by_user_id: ACTOR,
      }),
    );
  });

  it('create on a talent_record (pool-open) → always allowed', async () => {
    const { ctl, repo } = makeController();
    await ctl.create(
      makeAuth(['task:write']),
      { title: 'Screen', owner_type: 'talent_record', owner_id: 'tal-1' },
      'rq-1',
      makeReq(scopedVis()),
    );
    expect(repo.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PROOF — assignee validation (active within-tenant; cross-tenant/inactive
// rejected) — R5.
// ---------------------------------------------------------------------------
describe('Tasks proof — assignee validation (R5)', () => {
  it('an inactive / cross-tenant assignee → 422 VALIDATION_ERROR', async () => {
    const { ctl, repo, assignee } = makeController({ assigneeOk: false });
    await expect(
      ctl.create(
        makeAuth(['task:write']),
        { title: 'Call', owner_type: 'talent_record', owner_id: 'tal-1', assignee_id: 'u-x' },
        'rq-1',
        makeReq(scopedVis()),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
    expect(assignee.isActiveTenantMember).toHaveBeenCalledWith({ tenant_id: TENANT, user_id: 'u-x' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('an active within-tenant assignee → create proceeds', async () => {
    const { ctl, repo } = makeController({ assigneeOk: true });
    await ctl.create(
      makeAuth(['task:write']),
      { title: 'Call', owner_type: 'talent_record', owner_id: 'tal-1', assignee_id: 'u-ok' },
      'rq-1',
      makeReq(scopedVis()),
    );
    expect(repo.create).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PROOF — list routing (my-tasks default open; by-entity).
// ---------------------------------------------------------------------------
describe('Tasks proof — list routing', () => {
  it('no owner filter → my-tasks (assignee=actor, default status open)', async () => {
    const { ctl, repo } = makeController();
    await ctl.list(makeAuth(['task:read']), undefined, undefined, undefined, 'rq-1', makeReq(scopedVis()));
    expect(repo.listForAssignee).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, assignee_id: ACTOR, status: 'open' }),
    );
    expect(repo.listForOwner).not.toHaveBeenCalled();
  });

  it('owner_type+owner_id → by-entity list', async () => {
    const { ctl, repo } = makeController();
    await ctl.list(makeAuth(['task:read']), 'company', 'co-1', 'all', 'rq-1', makeReq(scopedVis()));
    expect(repo.listForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ owner_type: 'company', owner_id: 'co-1' }),
    );
    expect(repo.listForAssignee).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PROOF — scope-gate (the @RequireScopes route metadata).
// ---------------------------------------------------------------------------
describe('Tasks proof — scope-gate (route metadata)', () => {
  const read = (m: string) =>
    Reflect.getMetadata(REQUIRED_SCOPES_KEY, TaskController.prototype[m as keyof TaskController]);
  it('reads gate on task:read', () => {
    expect(read('list')).toEqual(['task:read']);
    expect(read('get')).toEqual(['task:read']);
  });
  it('writes gate on task:write', () => {
    expect(read('create')).toEqual(['task:write']);
    expect(read('update')).toEqual(['task:write']);
    expect(read('delete')).toEqual(['task:write']);
  });
});

// ---------------------------------------------------------------------------
// PROOF — mutate path re-checks owner visibility (404) + owner is immutable.
// ---------------------------------------------------------------------------
describe('Tasks proof — mutate gates on visibility (R6)', () => {
  it('PATCH a task whose owner is not visible → 404 (findByIdForActor null)', async () => {
    const { ctl, repo } = makeController();
    // The visibility OR excluded the row → the visibility-scoped fetch is null.
    repo.findByIdForActor.mockResolvedValue(null);
    await expect(
      ctl.update(makeAuth(['task:write']), 't-x', { status: 'done' }, 'rq-1', makeReq(scopedVis())),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('DELETE is hard (repo.delete called once owner visible)', async () => {
    const { ctl, repo } = makeController();
    await ctl.delete(makeAuth(['task:write']), 't1', 'rq-1', makeReq(scopedVis()));
    expect(repo.delete).toHaveBeenCalledWith({ id: 't1' });
  });
});
