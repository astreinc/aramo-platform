import 'reflect-metadata';
import { Injectable, type Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { TaskModule } from '../lib/task.module.js';
import { TaskController } from '../lib/task.controller.js';
import { TaskRepository } from '../lib/task.repository.js';
import {
  TASK_ASSIGNEE_VALIDATOR,
  StubTaskAssigneeValidator,
  type TaskAssigneeValidator,
} from '../lib/task-assignee.port.js';

// Task-Assignee Binding-Fix v1.0 — §3.3 GATE.
//
// THE proof the authz hole is shut. Before this fix, TASK_ASSIGNEE_VALIDATOR
// was bound to the accept-any StubTaskAssigneeValidator as a default INSIDE
// TaskModule, and the sole consumer — TaskController — resolves the token in
// TaskModule's OWN scope. AppModule's override sat in the parent scope and
// per-module hierarchical DI never propagated it down, so the live behavior
// was: silently accept ANY assignee (cross-tenant / inactive included),
// violating Ruling R5. Worse than cognito (which fails CLOSED) — this failed
// OPEN, an active authorization hole invisible to every unit test (they all
// construct TaskController directly and bypass DI).
//
// This spec boots TaskController THROUGH THE REAL DI GRAPH (TaskModule.forRoot)
// and proves the rebind CHANGES behavior — the opposite of an identical-
// behavior gate:
//   1. forRoot binds the passed validator in TaskModule's own scope (where
//      TaskController resolves it).
//   2. With an R5-enforcing validator: cross-tenant/inactive → 422; active
//      within-tenant member → success.
//   3. With the accept-any stub (the pre-fix default): the SAME cross-tenant
//      assignee is ACCEPTED — documenting the behavior the dead-wire produced
//      and proving the hole is now closed.
//
// DB-free: TaskRepository is overridden with a fake (the create path never
// touches Postgres), and the owner is a pool-open talent_record (always
// visible), so the request reaches the assignee check.

const TENANT = '01900000-0000-7000-8000-000000000001';
const ACTOR = '01900000-0000-7000-8000-0000000000aa';
const ACTIVE_MEMBER = '01900000-0000-7000-8000-0000000000b1';
const CROSS_TENANT_OR_INACTIVE = '0190ffff-0000-7000-8000-0000000000c2';
const OWNER_TALENT_ID = '01900000-0000-7000-8000-0000000000d3';

// An R5-enforcing validator with NO Nest dependencies — models the live
// TaskAssigneeAdapter's contract (active within-tenant member) deterministically
// so the DI proof needs no database. Active member of THIS tenant → true;
// anyone else (cross-tenant or inactive) → false.
@Injectable()
class R5EnforcingValidator implements TaskAssigneeValidator {
  async isActiveTenantMember(args: {
    tenant_id: string;
    user_id: string;
  }): Promise<boolean> {
    return args.tenant_id === TENANT && args.user_id === ACTIVE_MEMBER;
  }
}

function makeAuth(): AuthContextType {
  return {
    sub: ACTOR,
    tenant_id: TENANT,
    scopes: ['task:write'],
    consumer_type: 'tenant_user',
    capabilities: ['ats'],
  } as unknown as AuthContextType;
}

// A see-all request — talent_record is pool-open regardless, so the create
// reaches the assignee check rather than 404-ing on owner visibility.
function makeReq(): Request {
  return {
    resolveVisibility: async () => ({
      tenant_id: TENANT,
      actor_user_id: ACTOR,
      see_all_company: true,
      see_all_requisition: true,
      visible_client_ids: null,
    }),
    resolveVisibleRequisitionIds: async () => null,
    resolveVisibleContactIds: async () => null,
  } as unknown as Request;
}

function makeBody(assignee_id: string): never {
  return {
    title: 'Follow up with talent',
    owner_type: 'talent_record',
    owner_id: OWNER_TALENT_ID,
    assignee_id,
  } as never;
}

async function bootController(
  validator: Type<TaskAssigneeValidator>,
): Promise<{ ctl: TaskController; bound: unknown; create: ReturnType<typeof vi.fn> }> {
  const create = vi.fn().mockResolvedValue({ id: 't-created' });
  const fakeRepo = { create } as unknown as TaskRepository;

  const moduleRef = await Test.createTestingModule({
    imports: [TaskModule.forRoot({ assigneeValidator: validator })],
  })
    .overrideProvider(TaskRepository)
    .useValue(fakeRepo)
    .compile();

  return {
    ctl: moduleRef.get(TaskController),
    bound: moduleRef.get(TASK_ASSIGNEE_VALIDATOR),
    create,
  };
}

describe('Task-Assignee Binding-Fix — TASK_ASSIGNEE_VALIDATOR through real DI (§3.3)', () => {
  it('forRoot binds the passed validator IN TaskModule scope (where TaskController resolves it)', async () => {
    const { bound } = await bootController(R5EnforcingValidator);
    // The token resolves to the forRoot-passed class — NOT the accept-any
    // stub, NOT the fail-closed default. This is the dead-wire, closed.
    expect(bound).toBeInstanceOf(R5EnforcingValidator);
  });

  it('R5-enforcing validator → cross-tenant / inactive assignee rejected with 422', async () => {
    const { ctl, create } = await bootController(R5EnforcingValidator);
    let err: unknown;
    try {
      await ctl.create(makeAuth(), makeBody(CROSS_TENANT_OR_INACTIVE), 'req-1', makeReq());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AramoError);
    expect((err as AramoError).statusCode).toBe(422);
    expect((err as AramoError).context.details).toMatchObject({
      reason: 'assignee_not_active_tenant_member',
      assignee_id: CROSS_TENANT_OR_INACTIVE,
    });
    // R5 enforced BEFORE persistence — the task was never created.
    expect(create).not.toHaveBeenCalled();
  });

  it('R5-enforcing validator → active within-tenant member succeeds', async () => {
    const { ctl, create } = await bootController(R5EnforcingValidator);
    const view = await ctl.create(makeAuth(), makeBody(ACTIVE_MEMBER), 'req-2', makeReq());
    expect(view).toEqual({ id: 't-created' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('accept-any stub (the PRE-FIX default) would have ACCEPTED the cross-tenant assignee — the closed hole', async () => {
    // Booting forRoot with StubTaskAssigneeValidator reproduces the dead-wired
    // accept-any binding. The SAME cross-tenant assignee that the live adapter
    // rejects (422 above) sails through to persistence here — the fail-OPEN
    // behavior the rebind eliminates.
    const { ctl, create } = await bootController(StubTaskAssigneeValidator);
    const view = await ctl.create(
      makeAuth(),
      makeBody(CROSS_TENANT_OR_INACTIVE),
      'req-3',
      makeReq(),
    );
    expect(view).toEqual({ id: 't-created' });
    expect(create).toHaveBeenCalledOnce();
  });
});
