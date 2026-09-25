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

// CSP PA-2 — read-side provenance parity with Client Submittal. Per-requirement
// source layer + provenance flags (§6/§7), backend truth (never FE-inferred).
export interface PreStartRequirementProvenance {
  readonly inherited: boolean;
  readonly client_override: boolean;
  readonly client_added: boolean;
  readonly tenant_floor: boolean;
}
export interface EffectiveDefinitionView extends DefinitionView {
  readonly source: { readonly scope: ScopeTypeValue; readonly scope_ref_id: string; readonly version: string };
  readonly provenance: PreStartRequirementProvenance;
}
export interface PreStartLayerRef {
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
  readonly version: string;
  readonly checksum: string;
}
export interface EffectivePreStartView {
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
  readonly version: string;
  readonly checksum: string;
  readonly published_at: Date | null;
  readonly published_by: string | null;
  readonly definitions: readonly EffectiveDefinitionView[];
  readonly layers: readonly PreStartLayerRef[];
}
/** One raw (unmerged) pre-start layer for the editor's inherit/override deltas (§8). */
export interface PreStartLayerView {
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly checksum: string | null;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly definitions: readonly DefinitionView[];
}
export interface PreStartLayersView {
  readonly tenant: PreStartLayerView;
  readonly client: PreStartLayerView | null;
  readonly requisition: PreStartLayerView | null;
  readonly effective: EffectivePreStartView | null;
}
/** One immutable published set in the history read (§10). */
export interface PreStartHistoryEntry {
  readonly version: string;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly effective_to: string | null;
  readonly checksum: string;
  readonly status: 'current' | 'superseded';
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
  // CSP PA-2 — the SINGLE authoritative TENANT -> CLIENT -> REQUISITION merge, tracking
  // per-key source scope + tenant provenance so the decision path (resolveEffective) and
  // the read/admin path (resolveEffectiveView) can never diverge. The fail-closed FLOOR
  // guard (§D4-A, CSP PR-1) is enforced HERE for every caller.
  private async mergeLayered(
    tenant_id: string,
    context: LayeredContext,
    requestId: string,
  ): Promise<{
    contributing: Array<{ scope: ScopeTypeValue; set: SetRow }>;
    entries: Map<string, { view: DefinitionView; source: { scope: ScopeTypeValue; scope_ref_id: string; version: string } }>;
    tenantKeys: Set<string>;
    tenantFloorKeys: Set<string>;
  } | null> {
    const layers: Array<{ scope: ScopeTypeValue; ref: string }> = [
      { scope: 'TENANT', ref: tenant_id },
      ...(context.client_id !== null ? [{ scope: 'CLIENT' as ScopeTypeValue, ref: context.client_id }] : []),
      ...(context.requisition_id !== null
        ? [{ scope: 'REQUISITION' as ScopeTypeValue, ref: context.requisition_id }]
        : []),
    ];

    const entries = new Map<string, { view: DefinitionView; source: { scope: ScopeTypeValue; scope_ref_id: string; version: string } }>();
    const contributing: Array<{ scope: ScopeTypeValue; set: SetRow }> = [];
    const floors = new Map<string, StrictnessDims>();
    const tenantKeys = new Set<string>();
    const tenantFloorKeys = new Set<string>();
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
          floors.set(key, dims);
        }
        if (layer.scope === 'TENANT') {
          tenantKeys.add(key);
          if (view.override_policy === 'FLOOR') tenantFloorKeys.add(key);
        }
        entries.set(key, { view, source: { scope: layer.scope, scope_ref_id: layer.ref, version: setRow.version } });
      }
    }
    if (contributing.length === 0) return null;
    return { contributing, entries, tenantKeys, tenantFloorKeys };
  }

  private static byType(a: DefinitionView, b: DefinitionView): number {
    return a.requirement_type < b.requirement_type ? -1 : a.requirement_type > b.requirement_type ? 1 : 0;
  }

  private static effectiveChecksum(definitions: readonly DefinitionView[]): string {
    return checksumDefinitions(
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
  }

  // The decision path's authoritative merged read — return shape intentionally frozen.
  async resolveEffective(
    tenant_id: string,
    context: LayeredContext,
    requestId: string,
  ): Promise<SetView | null> {
    const m = await this.mergeLayered(tenant_id, context, requestId);
    if (m === null) return null;
    const anchor = m.contributing[m.contributing.length - 1]!.set;
    const definitions = [...m.entries.values()].map((e) => e.view).sort(DefinitionSetRepository.byType);
    const version = m.contributing.map((c) => `${c.scope}:${c.set.version}`).join('|');
    return { ...projectSet(anchor, []), version, checksum: DefinitionSetRepository.effectiveChecksum(definitions), definitions };
  }

  // The read/admin effective view (§7/§9): the same merge, each requirement annotated
  // with its source layer + provenance. Never used by the readiness decision path.
  async resolveEffectiveView(
    tenant_id: string,
    context: LayeredContext,
    requestId: string,
  ): Promise<EffectivePreStartView | null> {
    const m = await this.mergeLayered(tenant_id, context, requestId);
    if (m === null) return null;
    const anchor = m.contributing[m.contributing.length - 1]!.set;
    const definitions: EffectiveDefinitionView[] = [...m.entries.values()]
      .map((e) => {
        const fromTenant = e.source.scope === 'TENANT';
        const tenantHad = fromTenant || m.tenantKeys.has(e.view.requirement_type);
        return {
          ...e.view,
          source: e.source,
          provenance: {
            inherited: fromTenant,
            client_override: !fromTenant && tenantHad,
            client_added: !fromTenant && !tenantHad,
            tenant_floor: fromTenant
              ? e.view.override_policy === 'FLOOR'
              : m.tenantFloorKeys.has(e.view.requirement_type),
          },
        };
      })
      .sort(DefinitionSetRepository.byType);
    return {
      scope: anchor.scope as ScopeTypeValue,
      scope_ref_id: anchor.scope_ref_id,
      version: m.contributing.map((c) => `${c.scope}:${c.set.version}`).join('|'),
      checksum: DefinitionSetRepository.effectiveChecksum(definitions),
      published_at: anchor.published_at,
      published_by: anchor.published_by,
      definitions,
      layers: m.contributing.map((c) => ({
        scope: c.scope,
        scope_ref_id: c.set.scope_ref_id,
        version: c.set.version,
        checksum: c.set.checksum,
      })),
    };
  }

  // The raw per-layer read (§8): each scope's OWN open published set (unmerged) plus the
  // merged effective — powers inherit/override toggles and the "Tenant: X -> Client: Y" delta.
  async readLayers(
    tenant_id: string,
    context: LayeredContext,
    requestId: string,
  ): Promise<PreStartLayersView> {
    const layerFor = async (scope: ScopeTypeValue, ref: string | null): Promise<PreStartLayerView> => {
      if (ref === null) {
        return { scope, scope_ref_id: '', present: false, version: null, checksum: null, published_at: null, published_by: null, definitions: [] };
      }
      const setRow = (await this.prisma.preStartRequirementSet.findFirst({
        where: { tenant_id, scope, scope_ref_id: ref, state: 'published', effective_to: null },
        orderBy: { published_at: 'desc' },
      })) as SetRow | null;
      if (setRow === null) {
        return { scope, scope_ref_id: ref, present: false, version: null, checksum: null, published_at: null, published_by: null, definitions: [] };
      }
      const defRows = (await this.prisma.preStartRequirementDefinition.findMany({
        where: { tenant_id, set_id: setRow.id },
        orderBy: { sequence: 'asc' },
      })) as DefRow[];
      return {
        scope,
        scope_ref_id: ref,
        present: true,
        version: setRow.version,
        checksum: setRow.checksum,
        published_at: setRow.published_at === null ? null : setRow.published_at.toISOString(),
        published_by: setRow.published_by,
        definitions: defRows.map(projectDef),
      };
    };
    return {
      tenant: await layerFor('TENANT', tenant_id),
      client: context.client_id !== null ? await layerFor('CLIENT', context.client_id) : null,
      requisition: context.requisition_id !== null ? await layerFor('REQUISITION', context.requisition_id) : null,
      effective: await this.resolveEffectiveView(tenant_id, context, requestId),
    };
  }

  // The published-version history for one pre-start scope (§10), newest first.
  async history(
    tenant_id: string,
    scope: ScopeTypeValue,
    scope_ref_id: string,
  ): Promise<PreStartHistoryEntry[]> {
    // The full published lineage: the open 'published' set plus every 'superseded'
    // prior version (a draft has never been published, so it is excluded).
    const rows = (await this.prisma.preStartRequirementSet.findMany({
      where: { tenant_id, scope, scope_ref_id, state: { in: ['published', 'superseded'] } },
      orderBy: { published_at: 'desc' },
    })) as SetRow[];
    return rows.map((r) => ({
      version: r.version,
      published_at: r.published_at === null ? null : r.published_at.toISOString(),
      published_by: r.published_by,
      effective_to: r.effective_to === null ? null : r.effective_to.toISOString(),
      checksum: r.checksum,
      status: r.effective_to === null ? 'current' : 'superseded',
    }));
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
