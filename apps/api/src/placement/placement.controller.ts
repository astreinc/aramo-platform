import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { PlacementRepository, edgeAuthorityClass, type PlacementState } from '@aramo/placement';

import { CreatePlacementDto, TransitionPlacementDto } from './dto/placement.dto.js';

// Track 3 / E1-b — the guarded PlacementProcess HTTP surface (E1-b Approval
// Record). ONE generic transition route (§1): the target is in the body and the
// canonical 14-edge matrix (DB-trigger-enforced) owns legality — no named outcome
// routes. Authorization (§2) uses dedicated placement:* scopes; the transition
// route requires the placement:<class> scope DERIVED from the target edge under
// the ratified classification (data-dependent, so it is enforced here where the
// from/to pair is known, not as a static route scope). All placement scopes ship
// with ZERO default grants, so every route is fail-closed until a tenant assigns.
@Controller('v1/placements')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class PlacementController {
  constructor(private readonly placements: PlacementRepository) {}

  // Create on the explicit client-selection/offer fact (initial state
  // OFFER_EXTENDED). Duplicate live attempt → PLACEMENT_ALREADY_LIVE (409).
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('placement:create')
  async create(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Body() body: CreatePlacementDto,
  ) {
    return this.placements.createPlacement(
      {
        tenant_id: auth.tenant_id,
        submittal_id: body.submittal_id,
        requisition_id: body.requisition_id,
        talent_record_id: body.talent_record_id,
      },
      requestId,
    );
  }

  // Generic governed transition. The required scope is DATA-dependent on the edge:
  // ordinary progression → placement:transition, live/capacity → placement:activate,
  // terminal → placement:terminate. Checked here (before the state change); the
  // 14-edge matrix then enforces legality (PLACEMENT_STATE_INVALID, 422).
  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  async transition(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TransitionPlacementDto,
  ) {
    const current = await this.placements.findById(auth.tenant_id, id);
    if (current === null) {
      throw new AramoError('NOT_FOUND', 'PlacementProcess not found', 404, {
        requestId,
        details: { placement_process_id: id, reason: 'placement_process_not_found' },
      });
    }
    const cls = edgeAuthorityClass(current.state, body.to as PlacementState);
    const required = `placement:${cls}`;
    if (!auth.scopes.includes(required)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', `this transition requires the ${required} scope`, 403, {
        requestId,
        details: { placement_process_id: id, from_state: current.state, to_state: body.to, authority_class: cls, required_scope: required },
      });
    }
    return this.placements.transition(
      { tenant_id: auth.tenant_id, placement_process_id: id, to: body.to as PlacementState },
      requestId,
    );
  }

  @Get(':id')
  @RequireScopes('placement:read')
  async get(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const view = await this.placements.findById(auth.tenant_id, id);
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'PlacementProcess not found', 404, {
        requestId,
        details: { placement_process_id: id, reason: 'placement_process_not_found' },
      });
    }
    return view;
  }
}
