import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { SiteRepository } from './site.repository.js';
import {
  MAX_SITE_DEPTH,
  toView,
  validateCreate,
  validateUpdate,
  type SiteField,
  type SiteRow,
  type SiteView,
} from './sites.view.js';

// Settings Rebuild Directive 4 — sites/branches CRUD service.
//
// Every operation is on the CALLER's own tenant (tenant_id pinned from the JWT
// at the controller). Pure-input validation (types, lengths, UUID format) is
// done in sites.view.ts; this service owns the DB-dependent rules: the parent
// link (exists / same-tenant / active / no-self / no-cycle / depth), the dup-
// name pre-check, and the hard-delete in-use guard. All refusals are 400/404
// (never 500). Audit is emitted by the controller (the app-layer two-call
// seam) only when something actually changed (the no-op-no-audit precedent).

export interface CreateResult {
  view: SiteView;
  createdFields: SiteField[];
}
export interface UpdateResult {
  view: SiteView;
  changedFields: SiteField[];
}
export interface ToggleResult {
  view: SiteView;
  changed: boolean;
}

@Injectable()
export class SitesService {
  constructor(private readonly sites: SiteRepository) {}

  async list(tenantId: string): Promise<SiteView[]> {
    const rows = await this.sites.findAllForTenant(tenantId);
    return rows.map(toView);
  }

  async get(
    tenantId: string,
    siteId: string,
    requestId: string,
  ): Promise<SiteView> {
    const row = await this.requireOwned(tenantId, siteId, requestId);
    return toView(row);
  }

  async create(args: {
    tenantId: string;
    body: Record<string, unknown>;
    requestId: string;
  }): Promise<CreateResult> {
    const input = validateCreate(args.body, args.requestId);

    // Dup-name pre-check (the tenant-create precedent), plus a P2002 backstop
    // for a race — both surface as the same 400.
    const existing = await this.sites.findByNameForTenant(
      args.tenantId,
      input.name,
    );
    if (existing !== null) {
      throw nameTaken(input.name, args.requestId);
    }

    if (input.parent_site_id !== null) {
      const all = await this.sites.findAllForTenant(args.tenantId);
      this.assertParentValid({
        all,
        parentId: input.parent_site_id,
        selfId: null,
        requestId: args.requestId,
      });
    }

    let row: SiteRow;
    try {
      row = await this.sites.create({
        tenantId: args.tenantId,
        name: input.name,
        parentSiteId: input.parent_site_id,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken(input.name, args.requestId);
      throw err;
    }

    const createdFields: SiteField[] = ['name'];
    if (input.parent_site_id !== null) createdFields.push('parent_site_id');
    return { view: toView(row), createdFields };
  }

  async update(args: {
    tenantId: string;
    siteId: string;
    body: Record<string, unknown>;
    requestId: string;
  }): Promise<UpdateResult> {
    const patch = validateUpdate(args.body, args.requestId);
    const current = await this.requireOwned(
      args.tenantId,
      args.siteId,
      args.requestId,
    );

    // Compute the fields that ACTUALLY change (no-op → no write, no audit).
    const changedFields: SiteField[] = [];
    if (patch.name !== undefined && patch.name !== current.name) {
      changedFields.push('name');
    }
    if (
      patch.parent_site_id !== undefined &&
      (patch.parent_site_id ?? null) !== current.parent_site_id
    ) {
      changedFields.push('parent_site_id');
    }
    if (changedFields.length === 0) {
      return { view: toView(current), changedFields: [] };
    }

    if (changedFields.includes('name')) {
      const clash = await this.sites.findByNameForTenant(
        args.tenantId,
        patch.name as string,
      );
      if (clash !== null && clash.id !== current.id) {
        throw nameTaken(patch.name as string, args.requestId);
      }
    }

    if (changedFields.includes('parent_site_id')) {
      const next = patch.parent_site_id ?? null;
      if (next !== null) {
        const all = await this.sites.findAllForTenant(args.tenantId);
        this.assertParentValid({
          all,
          parentId: next,
          selfId: current.id,
          requestId: args.requestId,
        });
      }
    }

    const data: { name?: string; parent_site_id?: string | null } = {};
    if (changedFields.includes('name')) data.name = patch.name;
    if (changedFields.includes('parent_site_id')) {
      data.parent_site_id = patch.parent_site_id ?? null;
    }

    let row: SiteRow;
    try {
      row = await this.sites.update(args.tenantId, current.id, data);
    } catch (err) {
      if (isUniqueViolation(err) && data.name !== undefined) {
        throw nameTaken(data.name, args.requestId);
      }
      throw err;
    }
    return { view: toView(row), changedFields };
  }

  // Soft-deactivate (the chosen "delete" semantics for an in-use site). Flips
  // is_active=false; idempotent (re-deactivate → changed=false, no audit).
  async deactivate(args: {
    tenantId: string;
    siteId: string;
    requestId: string;
  }): Promise<ToggleResult> {
    const current = await this.requireOwned(
      args.tenantId,
      args.siteId,
      args.requestId,
    );
    if (current.is_active === false) {
      return { view: toView(current), changed: false };
    }
    const row = await this.sites.setActive(args.tenantId, current.id, false);
    return { view: toView(row), changed: true };
  }

  // Reactivate a deactivated branch. Idempotent (already active → changed=false).
  async reactivate(args: {
    tenantId: string;
    siteId: string;
    requestId: string;
  }): Promise<ToggleResult> {
    const current = await this.requireOwned(
      args.tenantId,
      args.siteId,
      args.requestId,
    );
    if (current.is_active === true) {
      return { view: toView(current), changed: false };
    }
    const row = await this.sites.setActive(args.tenantId, current.id, true);
    return { view: toView(row), changed: true };
  }

  // Hard-delete — GUARDED. A site referenced by any membership, or that still
  // has child branches, cannot be hard-deleted (it would orphan those refs);
  // the operator must deactivate instead. Only a truly-unused site is removed.
  async remove(args: {
    tenantId: string;
    siteId: string;
    requestId: string;
  }): Promise<void> {
    const current = await this.requireOwned(
      args.tenantId,
      args.siteId,
      args.requestId,
    );
    const [memberships, children] = await Promise.all([
      this.sites.countMemberships(args.tenantId, current.id),
      this.sites.countChildren(args.tenantId, current.id),
    ]);
    if (memberships > 0 || children > 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Site is in use and cannot be hard-deleted; deactivate it instead',
        400,
        {
          requestId: args.requestId,
          details: {
            reason: 'site_in_use',
            site_id: current.id,
            membership_count: memberships,
            child_count: children,
          },
        },
      );
    }
    await this.sites.hardDelete(args.tenantId, current.id);
  }

  private async requireOwned(
    tenantId: string,
    siteId: string,
    requestId: string,
  ): Promise<SiteRow> {
    const row = await this.sites.findByIdForTenant(tenantId, siteId);
    if (row === null) {
      // A missing site OR a cross-tenant id both surface as 404 (never reveal
      // that the id exists in another tenant).
      throw new AramoError('NOT_FOUND', 'Site not found', 404, {
        requestId,
        details: { site_id: siteId },
      });
    }
    return row;
  }

  // The DB-dependent parent rules, computed over the tenant's site set in
  // memory (small N; one query). Throws 400 on any violation.
  private assertParentValid(args: {
    all: SiteRow[];
    parentId: string;
    selfId: string | null;
    requestId: string;
  }): void {
    const { all, parentId, selfId, requestId } = args;
    const byId = new Map(all.map((s) => [s.id, s]));

    if (selfId !== null && parentId === selfId) {
      throw badParent('a site cannot be its own parent', requestId, 'parent_self');
    }

    const parent = byId.get(parentId);
    if (parent === undefined) {
      throw badParent(
        'parent_site_id does not reference a site in this tenant',
        requestId,
        'parent_not_found',
      );
    }
    if (parent.is_active === false) {
      throw badParent(
        'parent site is deactivated',
        requestId,
        'parent_inactive',
      );
    }

    // Cycle guard: walking up from the proposed parent must never reach self
    // (that would mean parent is in self's subtree). Per-path visited-set also
    // defends against any pre-existing malformed chain.
    if (selfId !== null) {
      const seen = new Set<string>();
      let cursor: string | null = parentId;
      while (cursor !== null) {
        if (cursor === selfId) {
          throw badParent(
            'parent_site_id would create a cycle',
            requestId,
            'parent_cycle',
          );
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        cursor = byId.get(cursor)?.parent_site_id ?? null;
      }
    }

    // Depth guard: depth(parent)+1 is the moved node's new depth; adding the
    // height of its existing subtree must not exceed MAX_SITE_DEPTH.
    const parentDepth = depthOf(parentId, byId);
    const subtreeHeight = selfId === null ? 0 : heightOf(selfId, all);
    if (parentDepth + 1 + subtreeHeight > MAX_SITE_DEPTH) {
      throw badParent(
        `branch hierarchy would exceed the maximum depth of ${MAX_SITE_DEPTH}`,
        requestId,
        'too_deep',
      );
    }
  }
}

// depth of a node = number of nodes from root to it (root = 1).
function depthOf(id: string, byId: Map<string, SiteRow>): number {
  const seen = new Set<string>();
  let depth = 0;
  let cursor: string | null = id;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = byId.get(cursor)?.parent_site_id ?? null;
  }
  return depth;
}

// height of a node's subtree = number of edges to its deepest descendant
// (a leaf = 0).
function heightOf(id: string, all: SiteRow[]): number {
  const childrenByParent = new Map<string, string[]>();
  for (const s of all) {
    if (s.parent_site_id !== null) {
      const arr = childrenByParent.get(s.parent_site_id) ?? [];
      arr.push(s.id);
      childrenByParent.set(s.parent_site_id, arr);
    }
  }
  const visit = (node: string, seen: Set<string>): number => {
    if (seen.has(node)) return 0;
    seen.add(node);
    const kids = childrenByParent.get(node) ?? [];
    let h = 0;
    for (const k of kids) h = Math.max(h, 1 + visit(k, seen));
    return h;
  };
  return visit(id, new Set<string>());
}

function badParent(
  message: string,
  requestId: string,
  reason: string,
): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, {
    requestId,
    details: { reason, field: 'parent_site_id' },
  });
}

function nameTaken(name: string, requestId: string): AramoError {
  return new AramoError(
    'VALIDATION_ERROR',
    'a site with this name already exists in this tenant',
    400,
    { requestId, details: { reason: 'name_taken', field: 'name' } },
  );
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
