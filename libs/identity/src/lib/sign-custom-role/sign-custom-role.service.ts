import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import type { EventType } from '../audit/identity-audit.repository.js';
import { bumpPrincipalVersion } from '../authorization-version.ops.js';
import { ESIGN_ROLE_KEYS, SIGN_ORGANIZATION_ROLE_KEYS } from '../dto/esign-permissions.js';
import { PrismaService } from '../prisma/prisma.service.js';

import {
  SIGN_CUSTOM_ROLES_PER_TENANT_MAX,
  checkCustomRoleScopes,
  composableScopesOf,
  normalizeCustomRoleText,
  scopesActorLacks,
} from './sign-custom-role.policy.js';

// Aramo Sign Feature-Parity Program Directive v1.0 (LOCKED) §1.21 — custom Sign roles.
//
// Every operation is TENANT-SCOPED: the tenant comes from the verified auth context (never
// the request), every read and write filters on it, and the database pins an assignment's
// role and membership to the same tenant (composite foreign keys). Every write runs in ONE
// transaction with:
//   - its IdentityAuditEvent row (identity.sign_custom_role.*), and
//   - the authorization-version bump of every principal whose effective scopes change, so an
//     already-issued compact token is stale on its very next request (HF-AUTH-1).
//
// Anti-escalation (sign-custom-role.policy.ts):
//   create          the new scope set ⊆ actor scopes, composable Sign scopes only
//   update          (current ∪ new) scope set ⊆ actor scopes
//   delete          current scope set ⊆ actor scopes; refused while the role is assigned
//   assign/unassign the role's scope set ⊆ actor scopes
// i.e. an actor can only create, change, hand out or take back authority it holds itself.
//
// Availability (sign.custom_roles NOT_AVAILABLE) and plan entitlement are decided by the
// calling Sign service before any of these run; this service is the authority for the data.

export interface SignCustomRoleActor {
  tenant_id: string;
  user_id: string;
  // The actor's effective Sign scopes (server-resolved for the `sign` consumer).
  scopes: readonly string[];
  request_id: string;
}

export interface SignCustomRoleView {
  id: string;
  name: string;
  description: string | null;
  scope_keys: string[];
  member_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface SignCustomRoleMemberView {
  user_id: string;
  email: string | null;
  display_name: string | null;
  // Built-in Sign product roles and organization roles the member holds (read-only here).
  role_keys: string[];
  custom_role_ids: string[];
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

interface LockedRole {
  id: string;
  name: string;
  scope_keys: string[];
}

@Injectable()
export class SignCustomRoleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenant_id: string): Promise<SignCustomRoleView[]> {
    const rows = await this.prisma.signCustomRole.findMany({
      where: { tenant_id, deleted_at: null },
      include: { _count: { select: { assignments: { where: { membership: { is_active: true } } } } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      scope_keys: composableScopesOf(r.scope_keys),
      member_count: r._count.assignments,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /** The organization's active members, their built-in Sign/organization roles and custom roles. */
  async listMembers(tenant_id: string): Promise<SignCustomRoleMemberView[]> {
    const visibleRoleKeys = [...SIGN_ORGANIZATION_ROLE_KEYS, ...ESIGN_ROLE_KEYS] as string[];
    const rows = await this.prisma.userTenantMembership.findMany({
      where: { tenant_id, is_active: true },
      include: {
        user: { select: { email: true, display_name: true, is_active: true } },
        role_assignments: { where: { role: { is_active: true, key: { in: visibleRoleKeys } } }, select: { role: { select: { key: true } } } },
        sign_custom_role_assignments: { where: { tenant_id, role: { deleted_at: null } }, select: { custom_role_id: true } },
      },
      orderBy: [{ joined_at: 'asc' }, { user_id: 'asc' }],
    });
    return rows
      .filter((r) => r.user.is_active)
      .map((r) => ({
        user_id: r.user_id,
        email: r.user.email,
        display_name: r.user.display_name,
        role_keys: [...new Set(r.role_assignments.map((a) => a.role.key))].sort(),
        custom_role_ids: r.sign_custom_role_assignments.map((a) => a.custom_role_id).sort(),
      }));
  }

  async create(actor: SignCustomRoleActor, input: { name: unknown; description?: unknown; scope_keys: unknown }): Promise<SignCustomRoleView> {
    const text = normalizeCustomRoleText(input.name, input.description);
    if (!text.ok) throw invalid(actor.request_id, text.reason);
    const scopes = this.guardScopes(actor, input.scope_keys);
    const id = uuidv7();
    try {
      await this.prisma.$transaction(async (tx) => {
        await lockTenantRoles(tx, actor.tenant_id);
        const live = await tx.signCustomRole.count({ where: { tenant_id: actor.tenant_id, deleted_at: null } });
        if (live >= SIGN_CUSTOM_ROLES_PER_TENANT_MAX) throw conflict(actor.request_id, 'This organization has the maximum number of custom roles', 'custom_role_limit');
        await tx.signCustomRole.create({
          data: { id, tenant_id: actor.tenant_id, name: text.name, description: text.description, scope_keys: scopes, created_by: actor.user_id },
        });
        await audit(tx, actor, 'identity.sign_custom_role.created', id, { custom_role_id: id, name: text.name, scope_keys: scopes });
      });
    } catch (err) {
      throw nameTaken(err, actor.request_id);
    }
    return this.view(actor.tenant_id, id, actor.request_id);
  }

  async update(actor: SignCustomRoleActor, id: string, input: { name?: unknown; description?: unknown; scope_keys?: unknown }): Promise<SignCustomRoleView> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await lockRole(tx, actor.tenant_id, id, actor.request_id);
        const text = normalizeCustomRoleText(input.name === undefined ? current.name : input.name, input.description);
        if (!text.ok) throw invalid(actor.request_id, text.reason);
        const next = input.scope_keys === undefined ? composableScopesOf(current.scope_keys) : this.guardScopes(actor, input.scope_keys);
        // Changing a role requires holding everything it grants today as well.
        assertActorHolds(actor, current.scope_keys);
        const before = composableScopesOf(current.scope_keys);
        const scopesChanged = before.join(' ') !== next.join(' ');
        await tx.signCustomRole.update({
          where: { id },
          data: {
            name: text.name,
            ...(input.description === undefined ? {} : { description: text.description }),
            scope_keys: next,
            updated_by: actor.user_id,
          },
        });
        if (scopesChanged) await bumpHolders(tx, actor.tenant_id, id);
        await audit(tx, actor, 'identity.sign_custom_role.updated', id, {
          custom_role_id: id,
          name: text.name,
          scope_keys: next,
          before: { name: current.name, scope_keys: before },
        });
      });
    } catch (err) {
      throw nameTaken(err, actor.request_id);
    }
    return this.view(actor.tenant_id, id, actor.request_id);
  }

  async remove(actor: SignCustomRoleActor, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await lockRole(tx, actor.tenant_id, id, actor.request_id);
      assertActorHolds(actor, current.scope_keys);
      const inUse = await tx.signCustomRoleAssignment.count({ where: { tenant_id: actor.tenant_id, custom_role_id: id } });
      if (inUse > 0) {
        throw conflict(actor.request_id, 'This role is assigned to members. Remove it from every member before deleting it.', 'custom_role_in_use', { assigned_count: inUse });
      }
      await tx.signCustomRole.update({ where: { id }, data: { deleted_at: new Date(), updated_by: actor.user_id } });
      await audit(tx, actor, 'identity.sign_custom_role.deleted', id, { custom_role_id: id, name: current.name, scope_keys: composableScopesOf(current.scope_keys) });
    });
  }

  async assign(actor: SignCustomRoleActor, id: string, user_id: string): Promise<{ assigned: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const role = await lockRole(tx, actor.tenant_id, id, actor.request_id);
      assertActorHolds(actor, role.scope_keys);
      const membership = await activeMembership(tx, actor.tenant_id, user_id, actor.request_id);
      const existing = await tx.signCustomRoleAssignment.findFirst({ where: { tenant_id: actor.tenant_id, custom_role_id: id, membership_id: membership.id }, select: { id: true } });
      if (existing !== null) return { assigned: false };
      await tx.signCustomRoleAssignment.create({
        data: { id: uuidv7(), tenant_id: actor.tenant_id, custom_role_id: id, membership_id: membership.id, created_by: actor.user_id },
      });
      await bumpPrincipalVersion(tx, { tenant_id: actor.tenant_id, principal_id: user_id });
      await audit(tx, actor, 'identity.sign_custom_role.assigned', user_id, {
        custom_role_id: id,
        membership_id: membership.id,
        name: role.name,
        scope_keys: composableScopesOf(role.scope_keys),
      });
      return { assigned: true };
    });
  }

  async unassign(actor: SignCustomRoleActor, id: string, user_id: string): Promise<{ unassigned: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const role = await lockRole(tx, actor.tenant_id, id, actor.request_id);
      assertActorHolds(actor, role.scope_keys);
      const membership = await tx.userTenantMembership.findFirst({ where: { tenant_id: actor.tenant_id, user_id }, select: { id: true } });
      if (membership === null) throw notFound(actor.request_id, 'member_not_found');
      const removed = await tx.signCustomRoleAssignment.deleteMany({ where: { tenant_id: actor.tenant_id, custom_role_id: id, membership_id: membership.id } });
      if (removed.count === 0) return { unassigned: false };
      await bumpPrincipalVersion(tx, { tenant_id: actor.tenant_id, principal_id: user_id });
      await audit(tx, actor, 'identity.sign_custom_role.unassigned', user_id, {
        custom_role_id: id,
        membership_id: membership.id,
        name: role.name,
        scope_keys: composableScopesOf(role.scope_keys),
      });
      return { unassigned: true };
    });
  }

  private guardScopes(actor: SignCustomRoleActor, raw: unknown): string[] {
    if (!Array.isArray(raw)) throw invalid(actor.request_id, 'scope_keys_required');
    const checked = checkCustomRoleScopes(raw, actor.scopes);
    if (checked.ok) return checked.scopes;
    if (checked.reason === 'scope_exceeds_actor') throw exceeds(actor.request_id, checked.scopes);
    if (checked.reason === 'scope_not_composable') throw invalid(actor.request_id, 'scope_not_composable', { scopes: checked.scopes });
    throw invalid(actor.request_id, checked.reason);
  }

  private async view(tenant_id: string, id: string, request_id: string): Promise<SignCustomRoleView> {
    const found = (await this.list(tenant_id)).find((r) => r.id === id);
    if (found === undefined) throw notFound(request_id, 'custom_role_not_found');
    return found;
  }
}

// One writer at a time per tenant's role set (the per-tenant limit and name checks).
async function lockTenantRoles(tx: Tx, tenant_id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:sign_custom_role:${tenant_id}`}, 0))`;
}

// Row-lock the live role IN THIS TENANT (a role of another tenant is simply not found).
async function lockRole(tx: Tx, tenant_id: string, id: string, request_id: string): Promise<LockedRole> {
  if (!UUID.test(id)) throw notFound(request_id, 'custom_role_not_found');
  const rows = await tx.$queryRaw<LockedRole[]>`
    SELECT id::text AS id, name, scope_keys FROM identity."SignCustomRole"
     WHERE id = ${id}::uuid AND tenant_id = ${tenant_id}::uuid AND deleted_at IS NULL
     FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) throw notFound(request_id, 'custom_role_not_found');
  return row;
}

async function activeMembership(tx: Tx, tenant_id: string, user_id: string, request_id: string): Promise<{ id: string }> {
  if (!UUID.test(user_id)) throw notFound(request_id, 'member_not_found');
  const m = await tx.userTenantMembership.findFirst({
    where: { tenant_id, user_id, is_active: true, user: { is_active: true } },
    select: { id: true },
  });
  if (m === null) throw notFound(request_id, 'member_not_found');
  return m;
}

// Every ACTIVE holder of the role (in its tenant) gets a new authorization version.
async function bumpHolders(tx: Tx, tenant_id: string, custom_role_id: string): Promise<number> {
  const holders = await tx.signCustomRoleAssignment.findMany({
    where: { tenant_id, custom_role_id, membership: { is_active: true } },
    select: { membership: { select: { user_id: true } } },
  });
  for (const h of holders) await bumpPrincipalVersion(tx, { tenant_id, principal_id: h.membership.user_id });
  return holders.length;
}

function assertActorHolds(actor: SignCustomRoleActor, roleScopes: readonly string[]): void {
  const lacking = scopesActorLacks(composableScopesOf(roleScopes), actor.scopes);
  if (lacking.length > 0) throw exceeds(actor.request_id, lacking);
}

async function audit(
  tx: Tx,
  actor: SignCustomRoleActor,
  event_type: Extract<EventType, `identity.sign_custom_role.${string}`>,
  subject_id: string,
  event_payload: Record<string, unknown>,
): Promise<void> {
  await tx.identityAuditEvent.create({
    data: { id: uuidv7(), tenant_id: actor.tenant_id, actor_id: actor.user_id, actor_type: 'user', event_type, subject_id, event_payload: { ...event_payload, request_id: actor.request_id } },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(requestId: string, reason: string, extra: Record<string, unknown> = {}): AramoError {
  return new AramoError('VALIDATION_ERROR', 'The custom role is not valid', 400, { requestId, details: { reason, ...extra } });
}

function exceeds(requestId: string, scopes: string[]): AramoError {
  return new AramoError('INSUFFICIENT_PERMISSIONS', 'You can only grant Sign permissions you hold yourself', 403, {
    requestId,
    details: { reason: 'scope_exceeds_actor', scopes },
  });
}

function notFound(requestId: string, reason: string): AramoError {
  return new AramoError('NOT_FOUND', 'Not found', 404, { requestId, details: { reason } });
}

function conflict(requestId: string, message: string, reason: string, extra: Record<string, unknown> = {}): AramoError {
  return new AramoError('SIGN_CUSTOM_ROLE_CONFLICT', message, 409, { requestId, details: { reason, ...extra } });
}

// A unique violation on the live (tenant, name) index → 409 name_taken; anything else rethrown.
function nameTaken(err: unknown, requestId: string): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'P2002' || code === '23505' || /SignCustomRole_tenant_id_name_live_key/.test(String((err as Error | null)?.message ?? ''))) {
    return conflict(requestId, 'A custom role with this name already exists', 'name_taken');
  }
  return err;
}
