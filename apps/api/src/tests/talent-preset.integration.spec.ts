import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import { TalentRecordController } from '@aramo/talent-record';
import { firstValueFrom, of } from 'rxjs';

import { TalentPresetResolverService } from '../talent-enrichment/talent-preset-resolver.service.js';
import { TalentPresetInterceptor } from '../talent-enrichment/talent-preset.interceptor.js';

// Segment 4c — INTEGRATION across the real seam:
//   interceptor resolves the cross-schema id set (activity/pipeline/tasks/teams,
//   mocked at the repo boundary) → stashes on req → the lib controller folds it
//   into the native query via id_allowlist / owner_id → searchPaged narrows.
// The fake searchPaged applies the allowlist + owner filter to a fixture, so the
// assertion is the actual narrowed result — not just the call args.

const FIXTURE = [
  { id: 't1', owner_id: 'me', first_name: 'Ann', last_name: 'A', core_talent_id: null },
  { id: 't2', owner_id: 'mate', first_name: 'Ben', last_name: 'B', core_talent_id: null },
  { id: 't3', owner_id: 'other', first_name: 'Cal', last_name: 'C', core_talent_id: null },
];

function fakeRepo() {
  const searchPaged = vi.fn(async (query: any) => {
    let items = FIXTURE.slice();
    if (query.id_allowlist != null) {
      const allow = new Set(query.id_allowlist as string[]);
      items = items.filter((i) => allow.has(i.id));
    }
    if (query.owner_id && query.owner_id.length > 0) {
      const owners = new Set(query.owner_id as string[]);
      items = items.filter((i) => owners.has(i.owner_id));
    }
    return {
      items,
      next_cursor: null,
      facets: { availability: [], engagement: [], source: [], hot: 0 },
    };
  });
  return { searchPaged };
}

function controllerWith(repo: { searchPaged: ReturnType<typeof vi.fn> }) {
  return new TalentRecordController(
    repo as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

const AUTH: AuthContextType = {
  sub: 'me',
  tenant_id: 'T',
  scopes: ['talent:read'],
} as unknown as AuthContextType;

function makeReq(query: Record<string, string>): any {
  return {
    method: 'GET',
    route: { path: '/v1/talent-records' },
    query: { paged: 'true', ...query },
    authContext: AUTH,
  };
}

async function runInterceptor(
  interceptor: TalentPresetInterceptor,
  req: any,
): Promise<void> {
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  const next = { handle: () => of('HANDLED') } as CallHandler;
  await firstValueFrom(interceptor.intercept(ctx, next));
}

// Drive the controller's paged list() with the (interceptor-populated) req.
async function listPaged(
  controller: TalentRecordController,
  req: any,
): Promise<{ id: string }[]> {
  const res = await controller.list(
    AUTH,
    undefined, // site_id
    undefined, // q
    undefined, // resume_q
    'true', // paged
    undefined, // sort
    undefined, // dir
    undefined, // cursor
    undefined, // page_size
    undefined, // availability
    undefined, // engagement
    undefined, // source
    undefined, // hot
    undefined, // owner
    undefined, // skills
    undefined, // skill_match
    undefined, // location
    req,
    'req-1',
  );
  return (res as { items: { id: string }[] }).items;
}

describe('Segment 4c — preset + My-team resolution → id_allowlist → narrowed result', () => {
  it('In touch <6mo → activity accessor → allowlist narrows to those ids', async () => {
    const activity = {
      findTalentIdsWithActivitySince: vi.fn().mockResolvedValue(['t1', 't3']),
    };
    const resolver = new TalentPresetResolverService(
      activity as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const interceptor = new TalentPresetInterceptor(resolver);
    const req = makeReq({ preset: 'in_touch_6mo' });

    await runInterceptor(interceptor, req);
    expect(req.talentPresetAllowlist).toEqual(['t1', 't3']);

    const items = await listPaged(controllerWith(fakeRepo()) , req);
    expect(items.map((i) => i.id)).toEqual(['t1', 't3']); // t2 excluded

    // resolved with a since ~6 calendar months back.
    const since = activity.findTalentIdsWithActivitySince.mock.calls[0]![0].since as Date;
    expect(since.getTime()).toBeLessThan(Date.now());
  });

  it('Submitted·this week → pipeline accessor (since ~7d) → allowlist narrows', async () => {
    const pipeline = {
      findTalentIdsSubmittedSince: vi.fn().mockResolvedValue(['t2']),
    };
    const resolver = new TalentPresetResolverService(
      {} as never,
      pipeline as never,
      {} as never,
      {} as never,
    );
    const req = makeReq({ preset: 'submitted_this_week' });
    await runInterceptor(new TalentPresetInterceptor(resolver), req);

    expect(req.talentPresetAllowlist).toEqual(['t2']);
    const items = await listPaged(controllerWith(fakeRepo()), req);
    expect(items.map((i) => i.id)).toEqual(['t2']);

    const since = pipeline.findTalentIdsSubmittedSince.mock.calls[0]![0].since as Date;
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('Needs follow-up → tasks accessor scoped by ASSIGNEE = current user (NOT creator)', async () => {
    const task = {
      findTalentIdsWithDueOrOverdueTasksForAssignee: vi
        .fn()
        .mockResolvedValue(['t2']),
    };
    const resolver = new TalentPresetResolverService(
      {} as never,
      {} as never,
      task as never,
      {} as never,
    );
    const req = makeReq({ preset: 'needs_follow_up' });
    await runInterceptor(new TalentPresetInterceptor(resolver), req);

    // THE assignee-not-creator assertion: scoped to authContext.sub as ASSIGNEE.
    const arg = task.findTalentIdsWithDueOrOverdueTasksForAssignee.mock.calls[0]![0];
    expect(arg.assignee_id).toBe('me');
    expect(arg.created_by_user_id).toBeUndefined();

    expect(req.talentPresetAllowlist).toEqual(['t2']);
    const items = await listPaged(controllerWith(fakeRepo()), req);
    expect(items.map((i) => i.id)).toEqual(['t2']);
  });

  it('My team → membership resolution → owner_id IN {me + teammates} narrows', async () => {
    // me ∈ teamA; teamA = {me, mate}. other (t3) is on no shared team.
    const team = {
      findMembershipsForUser: vi
        .fn()
        .mockResolvedValue([{ team_id: 'teamA', user_id: 'me' }]),
      findMembershipsForTeam: vi
        .fn()
        .mockResolvedValue([{ user_id: 'me' }, { user_id: 'mate' }]),
    };
    const resolver = new TalentPresetResolverService(
      {} as never,
      {} as never,
      {} as never,
      team as never,
    );
    const req = makeReq({ scope: 'my_team' });
    await runInterceptor(new TalentPresetInterceptor(resolver), req);

    expect(team.findMembershipsForUser).toHaveBeenCalledWith({
      tenant_id: 'T',
      user_id: 'me',
    });
    expect(new Set(req.talentScopeOwnerIds)).toEqual(new Set(['me', 'mate']));

    const items = await listPaged(controllerWith(fakeRepo()), req);
    expect(items.map((i) => i.id).sort()).toEqual(['t1', 't2']); // t3 (other) excluded
  });

  it('no preset / no scope → no allowlist, no owner override (full pool)', async () => {
    const resolver = new TalentPresetResolverService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const req = makeReq({});
    await runInterceptor(new TalentPresetInterceptor(resolver), req);

    expect(req.talentPresetAllowlist).toBeUndefined();
    expect(req.talentScopeOwnerIds).toBeUndefined();
    const items = await listPaged(controllerWith(fakeRepo()), req);
    expect(items.map((i) => i.id)).toEqual(['t1', 't2', 't3']); // unnarrowed
  });
});
