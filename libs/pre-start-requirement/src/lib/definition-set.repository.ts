import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { AramoError } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import { floorViolation, joinFloor, type StrictnessDims } from './floor-strictness.js';
import {
  checksumDefinitions,
  DEFAULT_OVERRIDE_POLICY,
  DEFAULT_SATISFACTION_POLICY,
  isRequirementDefinitionInput,
  isScopeType,
  type RequirementDefinitionInput,
  type ScopeTypeValue,
} from './pre-start-requirement-vocab.js';
import type {
  CreateDraftSetInput,
  DefinitionView,
  EditDraftSetInput,
  LayeredContext,
  PublishSetInput,
  ScopeSelector,
  SetView,
} from './pre-start-requirement.types.js';

// Row shapes as returned by Prisma (cast at the read boundary).
interface SetRow {
  id: string;
  tenant_id: string;
  scope: string;
  scope_ref_id: string;
  version: string;
  state: string;
  checksum: string;
  published_at: Date | null;
  published_by: string | null;
  effective_to: Date | null;
  created_at: Date;
  updated_at: Date;
}
interface DefRow {
  id: string;
  tenant_id: string;
  set_id: string;
  requirement_type: string;
  label: string;
  blocking: boolean;
  owner_role: string | null;
  sequence: number;
  waiver_mode: string;
  satisfaction_policy: string;
  override_policy: string;
  created_at: Date;
}

function projectDef(r: DefRow): DefinitionView {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    set_id: r.set_id,
    requirement_type: r.requirement_type as DefinitionView['requirement_type'],
    label: r.label,
    blocking: r.blocking,
    owner_role: r.owner_role,
    sequence: r.sequence,
    waiver_mode: r.waiver_mode as DefinitionView['waiver_mode'],
    satisfaction_policy: r.satisfaction_policy as DefinitionView['satisfaction_policy'],
    override_policy: r.override_policy as DefinitionView['override_policy'],
    created_at: r.created_at,
  };
}
function projectSet(r: SetRow, defs: readonly DefRow[]): SetView {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    scope: r.scope as SetView['scope'],
    scope_ref_id: r.scope_ref_id,
    version: r.version,
    state: r.state as SetView['state'],
    checksum: r.checksum,
    published_at: r.published_at,
    published_by: r.published_by,
    effective_to: r.effective_to,
    created_at: r.created_at,
    updated_at: r.updated_at,
    definitions: [...defs].sort((a, b) => a.sequence - b.sequence).map(projectDef),
  };
}

// DefinitionSetRepository — authoring + publication lifecycle for
// PreStartRequirementSet / PreStartRequirementDefinition (Track 3 / E2, §4).
//
// Publication is draft -> published -> superseded. Publishing a set supersedes
// the currently-open published set for the same (tenant, scope, scope_ref_id) in
// one transaction, so at most one open published set exists per scope. The set
// checksum is computed over the canonical definition serialization.
//
// SCOPE: a set is published at one of TENANT | CLIENT | REQUISITION. For TENANT,
// scope_ref_id === tenant_id; CLIENT/REQUISITION carry an in-tenant opaque
// client/requisition ref. resolveApplicable resolves ONE scope's open set;
// resolveEffective merges the layered TENANT -> CLIENT -> REQUISITION chain.
@Injectable()
export class DefinitionSetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createDraft(input: CreateDraftSetInput, requestId: string): Promise<SetView> {
    this.assertScope(input.scope, input.scope_ref_id, input.tenant_id, requestId);
    if (input.version.trim().length === 0) {
      throw this.invalid('version must be a non-empty string', requestId, { field: 'version' });
    }
    const defs = this.assertDefinitions(input.definitions, requestId);
    const checksum = checksumDefinitions(defs);

    const setId = uuidv7();
    const created = await this.prisma.$transaction(async (tx) => {
      const setRow = (await tx.preStartRequirementSet.create({
        data: {
          id: setId,
          tenant_id: input.tenant_id,
          scope: input.scope,
          scope_ref_id: input.scope_ref_id,
          version: input.version,
          state: 'draft',
          checksum,
        },
      })) as SetRow;
      const defRows = await this.insertDefinitions(tx, input.tenant_id, setId, defs);
      return { setRow, defRows };
    });
    return projectSet(created.setRow, created.defRows);
  }

  async editDraft(input: EditDraftSetInput, requestId: string): Promise<SetView> {
    const existing = (await this.prisma.preStartRequirementSet.findFirst({
      where: { tenant_id: input.tenant_id, id: input.set_id },
    })) as SetRow | null;
    if (existing === null) {
      throw this.notFound(input.set_id, requestId);
    }
    if (existing.state !== 'draft') {
      throw this.invalid('only a draft set may be edited', requestId, {
        set_id: input.set_id,
        state: existing.state,
      });
    }
    const defs = this.assertDefinitions(input.definitions, requestId);
    const checksum = checksumDefinitions(defs);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.preStartRequirementDefinition.deleteMany({ where: { tenant_id: input.tenant_id, set_id: input.set_id } });
      const defRows = await this.insertDefinitions(tx, input.tenant_id, input.set_id, defs);
      const setRow = (await tx.preStartRequirementSet.update({
        where: { id: input.set_id },
        data: { checksum },
      })) as SetRow;
      return { setRow, defRows };
    });
    return projectSet(result.setRow, result.defRows);
  }

  // Publish a draft. Supersedes the currently-open published set for the same
  // (tenant, scope, scope_ref_id) atomically.
  async publish(input: PublishSetInput, requestId: string): Promise<SetView> {
    const draft = (await this.prisma.preStartRequirementSet.findFirst({
      where: { tenant_id: input.tenant_id, id: input.set_id },
    })) as SetRow | null;
    if (draft === null) {
      throw this.notFound(input.set_id, requestId);
    }
    if (draft.state !== 'draft') {
      throw this.invalid('only a draft set may be published', requestId, {
        set_id: input.set_id,
        state: draft.state,
      });
    }
    const defCount = await this.prisma.preStartRequirementDefinition.count({
      where: { tenant_id: input.tenant_id, set_id: input.set_id },
    });
    if (defCount === 0) {
      throw this.invalid('a set must have at least one definition to publish', requestId, { set_id: input.set_id });
    }

    // CSP PR-1 (§D4-A) — publish-time EARLY floor guard (a UX/safety improvement only; the
    // authoritative fail-closed guarantee lives in resolveEffective). A CLIENT set may not
    // weaken a TENANT FLOOR requirement. REQUISITION-vs-broader is left to resolveEffective,
    // which carries the requisition's client context.
    if (draft.scope === 'CLIENT') {
      const tenantFloors = await this.publishedFloors(input.tenant_id, 'TENANT', input.tenant_id);
      if (tenantFloors.size > 0) {
        const draftDefs = (await this.prisma.preStartRequirementDefinition.findMany({
          where: { tenant_id: input.tenant_id, set_id: input.set_id },
          orderBy: { sequence: 'asc' },
        })) as DefRow[];
        for (const d of draftDefs) {
          const view = projectDef(d);
          const floor = tenantFloors.get(view.requirement_type);
          if (floor === undefined) continue;
          const violated = floorViolation(
            { blocking: view.blocking, waiver_mode: view.waiver_mode, satisfaction_policy: view.satisfaction_policy },
            floor,
          );
          if (violated !== null) {
            throw this.invalid(
              `CLIENT set weakens the TENANT FLOOR for ${view.requirement_type} on ${violated}`,
              requestId,
              { reason: 'FLOOR_VIOLATION', requirement_type: view.requirement_type, scope: 'CLIENT', dimension: violated },
            );
          }
        }
      }
    }

    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      // Supersede any currently-open published set for this scope.
      await tx.preStartRequirementSet.updateMany({
        where: {
          tenant_id: draft.tenant_id,
          scope: draft.scope,
          scope_ref_id: draft.scope_ref_id,
          state: 'published',
          effective_to: null,
        },
        data: { state: 'superseded', effective_to: now },
      });
      const setRow = (await tx.preStartRequirementSet.update({
        where: { id: input.set_id },
        data: { state: 'published', published_at: now, published_by: input.published_by },
      })) as SetRow;
      const defRows = (await tx.preStartRequirementDefinition.findMany({
        where: { tenant_id: input.tenant_id, set_id: input.set_id },
        orderBy: { sequence: 'asc' },
      })) as DefRow[];
      return { setRow, defRows };
    });
    return projectSet(result.setRow, result.defRows);
  }

  // Resolve the applicable published set for a SINGLE scope (the one an instance
  // materializes from) — one open published set, no layered merge. The layered
  // TENANT -> CLIENT -> REQUISITION merge is resolveEffective's job.
  async resolveApplicable(
    tenant_id: string,
    selector: ScopeSelector,
    requestId: string,
  ): Promise<SetView | null> {
    this.assertScope(selector.scope, selector.scope_ref_id, tenant_id, requestId);
    const setRow = (await this.prisma.preStartRequirementSet.findFirst({
      where: {
        tenant_id,
        scope: selector.scope,
        scope_ref_id: selector.scope_ref_id,
        state: 'published',
        effective_to: null,
      },
      orderBy: { published_at: 'desc' },
    })) as SetRow | null;
    if (setRow === null) {
      return null;
    }
    const defRows = (await this.prisma.preStartRequirementDefinition.findMany({
      where: { tenant_id, set_id: setRow.id },
      orderBy: { sequence: 'asc' },
    })) as DefRow[];
    return projectSet(setRow, defRows);
  }

  // L5-P5 (ruling P2) — resolve the EFFECTIVE published config for a placement by
  // merging the layered chain TENANT -> CLIENT -> REQUISITION (least-specific first).
  // A more-specific layer OVERRIDES a same-requirement_type definition and AUGMENTS
  // with new types. Deterministic: fixed layer order + a stable requirement_type sort.
  // Each merged definition keeps its authored id (requirement_definition_id), so the
  // materialized instance records exactly which layer's definition it came from. The
  // synthetic effective SetView's version is the composite of the contributing layer
  // versions and its checksum hashes the merged definitions. Null when NO layer has an
  // open published set (fail-closed, as the single-scope resolver).
  async resolveEffective(
    tenant_id: string,
    context: LayeredContext,
    requestId: string,
  ): Promise<SetView | null> {
    const layers: Array<{ scope: ScopeTypeValue; ref: string }> = [
      { scope: 'TENANT', ref: tenant_id },
      ...(context.client_id !== null ? [{ scope: 'CLIENT' as ScopeTypeValue, ref: context.client_id }] : []),
      ...(context.requisition_id !== null
        ? [{ scope: 'REQUISITION' as ScopeTypeValue, ref: context.requisition_id }]
        : []),
    ];

    const merged = new Map<string, DefinitionView>();
    const contributing: Array<{ scope: ScopeTypeValue; set: SetRow }> = [];
    // CSP PR-1 (§D4-A) — the AUTHORITATIVE, fail-closed FLOOR guard. Independent of the
    // publish-time early check: a bad policy from an old row, a migration anomaly, a direct
    // DB write or a future write path is still refused HERE. Per requirement_type we carry
    // the accumulated (effective) FLOOR down the TENANT -> CLIENT -> REQUISITION chain; a
    // more-specific layer must be at-least-as-strict as it, and any strengthening RAISES the
    // floor for deeper layers. When no requirement is FLOOR the map stays empty and the loop
    // reduces to the plain union merge (DEFAULT behaviour is unchanged).
    const floors = new Map<string, StrictnessDims>();
    for (const layer of layers) {
      const setRow = (await this.prisma.preStartRequirementSet.findFirst({
        where: { tenant_id, scope: layer.scope, scope_ref_id: layer.ref, state: 'published', effective_to: null },
        orderBy: { published_at: 'desc' },
      })) as SetRow | null;
      if (setRow === null) continue;
      const defRows = (await this.prisma.preStartRequirementDefinition.findMany({
        where: { tenant_id, set_id: setRow.id },
        orderBy: { sequence: 'asc' },
      })) as DefRow[];
      contributing.push({ scope: layer.scope, set: setRow });
      // More-specific layers run later and overwrite the same requirement_type.
      for (const d of defRows) {
        const view = projectDef(d);
        const key = view.requirement_type;
        const dims: StrictnessDims = {
          blocking: view.blocking,
          waiver_mode: view.waiver_mode,
          satisfaction_policy: view.satisfaction_policy,
        };
        const inherited = floors.get(key);
        if (inherited !== undefined) {
          // Floor-protected by a broader scope: validate the override BEFORE merging it,
          // then accumulate so a strengthening raises the floor for the next layer.
          const violated = floorViolation(dims, inherited);
          if (violated !== null) {
            throw this.invalid(
              `requirement ${key} at scope ${layer.scope} weakens an inherited FLOOR on ${violated}`,
              requestId,
              { reason: 'FLOOR_VIOLATION', requirement_type: key, scope: layer.scope, dimension: violated },
            );
          }
          floors.set(key, joinFloor(inherited, dims));
        } else if (view.override_policy === 'FLOOR') {
          // A new floor starts at this scope (independent of broader layers being DEFAULT).
          floors.set(key, dims);
        }
        merged.set(key, view);
      }
    }
    if (contributing.length === 0) return null;

    const anchor = contributing[contributing.length - 1]!.set; // most-specific present layer
    const definitions = [...merged.values()].sort((a, b) =>
      a.requirement_type < b.requirement_type ? -1 : a.requirement_type > b.requirement_type ? 1 : 0,
    );
    const version = contributing.map((c) => `${c.scope}:${c.set.version}`).join('|');
    const checksum = checksumDefinitions(
      definitions.map((d) => ({
        requirement_type: d.requirement_type,
        label: d.label,
        blocking: d.blocking,
        owner_role: d.owner_role,
        sequence: d.sequence,
        waiver_mode: d.waiver_mode,
        satisfaction_policy: d.satisfaction_policy,
      })),
    );
    return { ...projectSet(anchor, []), version, checksum, definitions };
  }

  async findById(tenant_id: string, set_id: string): Promise<SetView | null> {
    const setRow = (await this.prisma.preStartRequirementSet.findFirst({
      where: { tenant_id, id: set_id },
    })) as SetRow | null;
    if (setRow === null) return null;
    const defRows = (await this.prisma.preStartRequirementDefinition.findMany({
      where: { tenant_id, set_id },
      orderBy: { sequence: 'asc' },
    })) as DefRow[];
    return projectSet(setRow, defRows);
  }

  // ---- helpers ----------------------------------------------------------------

  private async insertDefinitions(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    tenant_id: string,
    set_id: string,
    defs: readonly RequirementDefinitionInput[],
  ): Promise<DefRow[]> {
    const rows: DefRow[] = [];
    for (const d of defs) {
      const row = (await tx.preStartRequirementDefinition.create({
        data: {
          id: uuidv7(),
          tenant_id,
          set_id,
          requirement_type: d.requirement_type,
          label: d.label,
          blocking: d.blocking,
          owner_role: d.owner_role,
          sequence: d.sequence,
          waiver_mode: d.waiver_mode,
          satisfaction_policy: d.satisfaction_policy ?? DEFAULT_SATISFACTION_POLICY,
          override_policy: d.override_policy ?? DEFAULT_OVERRIDE_POLICY,
        },
      })) as DefRow;
      rows.push(row);
    }
    return rows;
  }

  private assertScope(scope: string, scope_ref_id: string, tenant_id: string, requestId: string): void {
    if (!isScopeType(scope)) {
      throw this.invalid(`scope must be one of the supported scope types (TENANT | CLIENT | REQUISITION)`, requestId, { scope });
    }
    // §4b: TENANT scope_ref_id is the tenant itself. CLIENT/REQUISITION carry the
    // client/account or requisition id (an in-tenant opaque ref, no equality rule).
    if (scope === 'TENANT' && scope_ref_id !== tenant_id) {
      throw this.invalid('TENANT scope_ref_id must equal tenant_id', requestId, { scope_ref_id, tenant_id });
    }
  }

  private assertDefinitions(
    defs: readonly unknown[],
    requestId: string,
  ): readonly RequirementDefinitionInput[] {
    if (!Array.isArray(defs) || defs.length === 0) {
      throw this.invalid('a set must declare at least one requirement definition', requestId, {});
    }
    const seenTypes = new Set<string>();
    const seenSeq = new Set<number>();
    for (const d of defs) {
      if (!isRequirementDefinitionInput(d)) {
        throw this.invalid('a requirement definition is malformed or references an unknown requirement_type/waiver_mode', requestId, {});
      }
      if (seenTypes.has(d.requirement_type)) {
        throw this.invalid('duplicate requirement_type within a set', requestId, { requirement_type: d.requirement_type });
      }
      if (seenSeq.has(d.sequence)) {
        throw this.invalid('duplicate sequence within a set', requestId, { sequence: d.sequence });
      }
      seenTypes.add(d.requirement_type);
      seenSeq.add(d.sequence);
    }
    return defs as readonly RequirementDefinitionInput[];
  }

  private invalid(message: string, requestId: string, details: Record<string, unknown>): AramoError {
    return new AramoError('PRE_START_REQUIREMENT_INVALID', message, 422, { requestId, details });
  }

  // CSP PR-1 — the FLOOR requirements of the currently-open published set at a given
  // scope, as strictness dimensions keyed by requirement_type (empty when no open set).
  private async publishedFloors(
    tenant_id: string,
    scope: ScopeTypeValue,
    scope_ref_id: string,
  ): Promise<Map<string, StrictnessDims>> {
    const floors = new Map<string, StrictnessDims>();
    const setRow = (await this.prisma.preStartRequirementSet.findFirst({
      where: { tenant_id, scope, scope_ref_id, state: 'published', effective_to: null },
      orderBy: { published_at: 'desc' },
    })) as SetRow | null;
    if (setRow === null) return floors;
    const defs = (await this.prisma.preStartRequirementDefinition.findMany({
      where: { tenant_id, set_id: setRow.id },
    })) as DefRow[];
    for (const d of defs) {
      const view = projectDef(d);
      if (view.override_policy === 'FLOOR') {
        floors.set(view.requirement_type, {
          blocking: view.blocking,
          waiver_mode: view.waiver_mode,
          satisfaction_policy: view.satisfaction_policy,
        });
      }
    }
    return floors;
  }
  private notFound(set_id: string, requestId: string): AramoError {
    return new AramoError('NOT_FOUND', 'PreStartRequirementSet not found', 404, {
      requestId,
      details: { set_id, reason: 'set_not_found' },
    });
  }
}
