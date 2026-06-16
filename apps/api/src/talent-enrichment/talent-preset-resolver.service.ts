import { Injectable } from '@nestjs/common';
import { ActivityRepository } from '@aramo/activity';
import { PipelineRepository } from '@aramo/pipeline';
import { TaskRepository } from '@aramo/task';
import { TeamRepository } from '@aramo/identity';

// Segment 4c — Views presets + "My team" scope RESOLVER. Lives in apps/api (the
// only layer permitted to read activity / pipeline / tasks / teams together);
// libs/talent-record stays single-schema. Each cross-schema preset resolves an
// id set HERE and the talent-record lib filters by it via the 4a id_allowlist
// hook — resolve-ids-then-filter, NEVER a cross-schema JOIN.
//
// GUARD: every resolution is bounded by the 4b materialize guard
// (TALENT_XFACET_GUARD). Each accessor takes the guard as its limit and returns
// at most guard+1 ids; an over-guard preset therefore lands a guard+1 allowlist,
// which the existing 4b cross-facet path reports as over_guard ("narrow your
// filters") — the guard stays consistent, never special-cased off.

const DEFAULT_XFACET_GUARD = 5000;
function xfacetGuard(): number {
  const raw = process.env['TALENT_XFACET_GUARD'];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_XFACET_GUARD;
}

// The three CROSS-SCHEMA presets. "Available now" is NATIVE (availability_status
// filter — no id resolution) so it never reaches this resolver.
export const TALENT_PRESETS = [
  'in_touch_6mo',
  'submitted_this_week',
  'needs_follow_up',
] as const;
export type TalentPreset = (typeof TALENT_PRESETS)[number];
export function isTalentPreset(value: string): value is TalentPreset {
  return (TALENT_PRESETS as readonly string[]).includes(value);
}

interface PresetCtx {
  tenant_id: string;
  user_id: string; // the authenticated principal (authContext.sub)
  now: Date;
}

@Injectable()
export class TalentPresetResolverService {
  constructor(
    private readonly activity: ActivityRepository,
    private readonly pipeline: PipelineRepository,
    private readonly task: TaskRepository,
    private readonly team: TeamRepository,
  ) {}

  // Resolve a cross-schema preset to its talent-id allowlist (possibly empty —
  // an empty allowlist correctly narrows to zero results, distinct from "no
  // preset" which leaves id_allowlist unset). Bounded by the guard.
  async resolvePreset(preset: TalentPreset, ctx: PresetCtx): Promise<string[]> {
    const guard = xfacetGuard();
    switch (preset) {
      case 'in_touch_6mo': {
        // last_activity_at >= now − 6 months (calendar months, not 180d).
        const since = new Date(ctx.now);
        since.setMonth(since.getMonth() - 6);
        return this.activity.findTalentIdsWithActivitySince({
          tenant_id: ctx.tenant_id,
          since,
          limit: guard,
        });
      }
      case 'submitted_this_week': {
        const since = new Date(ctx.now.getTime() - 7 * 86_400_000);
        return this.pipeline.findTalentIdsSubmittedSince({
          tenant_id: ctx.tenant_id,
          since,
          limit: guard,
        });
      }
      case 'needs_follow_up': {
        // open tasks ASSIGNED to me (not created by me) due today or earlier.
        const asOf = endOfDay(ctx.now);
        return this.task.findTalentIdsWithDueOrOverdueTasksForAssignee({
          tenant_id: ctx.tenant_id,
          assignee_id: ctx.user_id,
          as_of: asOf,
          limit: guard,
        });
      }
    }
  }

  // "My team" scope → owner_id set: every teammate across every team I belong
  // to, plus me. Identity-schema read (TeamRepository); the resolved ids feed
  // the existing NATIVE owner_id IN filter (the visibility pattern — ids passed
  // in, single-schema, no join). A user in no team folds to just [me].
  async resolveTeamOwnerIds(ctx: {
    tenant_id: string;
    user_id: string;
  }): Promise<string[]> {
    const myMemberships = await this.team.findMembershipsForUser({
      tenant_id: ctx.tenant_id,
      user_id: ctx.user_id,
    });
    const teamIds = [...new Set(myMemberships.map((m) => m.team_id))];
    const memberRows = await Promise.all(
      teamIds.map((team_id) =>
        this.team.findMembershipsForTeam({ tenant_id: ctx.tenant_id, team_id }),
      ),
    );
    const ids = new Set<string>([ctx.user_id]);
    for (const rows of memberRows) for (const r of rows) ids.add(r.user_id);
    return [...ids];
  }
}

function endOfDay(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}
