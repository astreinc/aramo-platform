import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseFilters } from '@nestjs/common';
import { AramoExceptionFilter, RequestId } from '@aramo/common';
import { AuthContext, type AuthContextType } from '@aramo/auth';
import {
  ESIGN_SCOPE,
  EsignSenderBoundary,
  SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES,
  SignCustomRoleService,
  type SignCustomRoleActor,
  type SignCustomRoleView,
} from '@aramo/identity';

import { SignCustomRolesGate } from './sign-custom-roles.gate.js';

// Aramo Sign Feature-Parity Program Directive v1.0 (LOCKED) §1.21 — custom roles and
// permissions, administered in the Sign workspace by holders of sign:member:manage (Sign
// Admin; the organization's Tenant Owner / Tenant Admin):
//
//   GET    v1/sign/sender/custom-roles                       roles + the composable Sign permissions
//   POST   v1/sign/sender/custom-roles                       create
//   PATCH  v1/sign/sender/custom-roles/:id                   edit name, description, permissions
//   DELETE v1/sign/sender/custom-roles/:id                   delete (refused while assigned)
//   GET    v1/sign/sender/custom-roles/members               members and the roles they hold
//   PUT    v1/sign/sender/custom-roles/:id/members/:user_id  assign
//   DELETE v1/sign/sender/custom-roles/:id/members/:user_id  remove
//
// DARK: every route is refused (ESIGN_FEATURE_NOT_AVAILABLE) while `sign.custom_roles` is
// NOT_AVAILABLE, for a PERSONAL tenant, and for a plan without the feature (SignCustomRolesGate).
// tenant_id, the actor and the actor's scopes come only from the verified auth context.

const MANAGE = ESIGN_SCOPE.MEMBER_MANAGE;

@Controller('v1/sign/sender/custom-roles')
@UseFilters(AramoExceptionFilter)
export class SignCustomRolesController {
  constructor(
    private readonly roles: SignCustomRoleService,
    private readonly gate: SignCustomRolesGate,
  ) {}

  @Get()
  @EsignSenderBoundary(MANAGE)
  async list(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    await this.gate.assertUsable(auth, requestId);
    const held = new Set(auth.scopes);
    return {
      // Every permission a custom role may be composed of, and whether the caller may grant it.
      permissions: SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES.map((key) => ({ key, grantable: held.has(key) })),
      roles: (await this.roles.list(auth.tenant_id)).map(toWire),
    };
  }

  @Get('members')
  @EsignSenderBoundary(MANAGE)
  async members(@AuthContext() auth: AuthContextType, @RequestId() requestId: string) {
    await this.gate.assertUsable(auth, requestId);
    return { members: await this.roles.listMembers(auth.tenant_id) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @EsignSenderBoundary(MANAGE)
  async create(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Body() body: { name?: unknown; description?: unknown; scope_keys?: unknown }) {
    await this.gate.assertUsable(auth, requestId);
    return { role: toWire(await this.roles.create(actorOf(auth, requestId), { name: body?.name, description: body?.description, scope_keys: body?.scope_keys })) };
  }

  @Patch(':id')
  @EsignSenderBoundary(MANAGE)
  async update(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: { name?: unknown; description?: unknown; scope_keys?: unknown },
  ) {
    await this.gate.assertUsable(auth, requestId);
    return { role: toWire(await this.roles.update(actorOf(auth, requestId), id, { name: body?.name, description: body?.description, scope_keys: body?.scope_keys })) };
  }

  @Delete(':id')
  @EsignSenderBoundary(MANAGE)
  async remove(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string) {
    await this.gate.assertUsable(auth, requestId);
    await this.roles.remove(actorOf(auth, requestId), id);
    return { deleted: true };
  }

  @Put(':id/members/:user_id')
  @EsignSenderBoundary(MANAGE)
  async assign(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('user_id') userId: string) {
    await this.gate.assertUsable(auth, requestId);
    return this.roles.assign(actorOf(auth, requestId), id, userId);
  }

  @Delete(':id/members/:user_id')
  @EsignSenderBoundary(MANAGE)
  async unassign(@AuthContext() auth: AuthContextType, @RequestId() requestId: string, @Param('id') id: string, @Param('user_id') userId: string) {
    await this.gate.assertUsable(auth, requestId);
    return this.roles.unassign(actorOf(auth, requestId), id, userId);
  }
}

function actorOf(auth: AuthContextType, requestId: string): SignCustomRoleActor {
  return { tenant_id: auth.tenant_id, user_id: auth.sub, scopes: auth.scopes, request_id: requestId };
}

function toWire(r: SignCustomRoleView) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    scope_keys: r.scope_keys,
    member_count: r.member_count,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  };
}
