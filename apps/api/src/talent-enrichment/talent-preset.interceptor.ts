import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import type { Request } from 'express';
import { from, type Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';

import {
  isTalentPreset,
  TalentPresetResolverService,
} from './talent-preset-resolver.service.js';

// Segment 4c — TalentPresetInterceptor (PRE-handler).
//
// Mirror of the enrichment seam, but the OTHER direction: this resolves the
// cross-schema preset/scope id sets in apps/api (the only layer allowed to read
// activity/pipeline/tasks/teams) and stashes them on the request BEFORE the lib
// controller runs, so the controller folds them into the native query via the
// 4a id_allowlist / owner_id hooks. The await completes before next.handle(),
// so the resolved ids are present when the handler builds the query.
//
// Scope-tabs: the owner-is-me tab (owner_id = me) and the all tab (no owner
// filter) are wired by the existing native `owner` param — only my_team needs
// identity-schema resolution, so only `scope=my_team` is handled here.
type PresetRequest = Request & {
  authContext?: AuthContextType;
  talentPresetAllowlist?: readonly string[];
  talentScopeOwnerIds?: readonly string[];
};

@Injectable()
export class TalentPresetInterceptor implements NestInterceptor {
  constructor(private readonly resolver: TalentPresetResolverService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<PresetRequest>();
    const authContext = req.authContext;
    const isPagedListRoute =
      req.method === 'GET' &&
      req.route?.path === '/v1/talent-records' &&
      req.query?.['paged'] === 'true';

    if (!isPagedListRoute || authContext === undefined) {
      return next.handle();
    }

    const presetParam = req.query['preset'];
    const scopeParam = req.query['scope'];
    const preset =
      typeof presetParam === 'string' && isTalentPreset(presetParam)
        ? presetParam
        : undefined;
    const wantsTeam = scopeParam === 'my_team';
    // CRM-2 — "Working with me" scope tab (replaces the owner_id-based "My
    // talent"). Resolves to a talent-id allowlist (assigned reqs × active
    // pipeline), NOT owner_id.
    const wantsWorkingWithMe = scopeParam === 'working_with_me';

    if (preset === undefined && !wantsTeam && !wantsWorkingWithMe) {
      return next.handle();
    }

    const ctx = {
      tenant_id: authContext.tenant_id,
      user_id: authContext.sub,
      now: new Date(),
    };

    return from(
      (async () => {
        const presetIds =
          preset !== undefined
            ? await this.resolver.resolvePreset(preset, ctx)
            : undefined;
        const wwmIds = wantsWorkingWithMe
          ? await this.resolver.resolveWorkingWithMe(ctx)
          : undefined;
        // Both active → INTERSECT (the single id_allowlist is ANDed in the
        // query, so pre-intersect here). Either alone → that set.
        if (wwmIds !== undefined && presetIds !== undefined) {
          const keep = new Set(presetIds);
          req.talentPresetAllowlist = wwmIds.filter((id) => keep.has(id));
        } else if (wwmIds !== undefined) {
          req.talentPresetAllowlist = wwmIds;
        } else if (presetIds !== undefined) {
          req.talentPresetAllowlist = presetIds;
        }
        if (wantsTeam) {
          req.talentScopeOwnerIds = await this.resolver.resolveTeamOwnerIds(ctx);
        }
      })(),
    ).pipe(switchMap(() => next.handle()));
  }
}
