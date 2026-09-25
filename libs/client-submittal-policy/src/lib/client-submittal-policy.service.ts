import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { evaluate, type PolicyContext, type PolicyDecision } from '@aramo/policy-engine';
import { selectEffectiveAt } from '@aramo/policy-store';

import {
  CLIENT_SUBMITTAL_POLICY_GATEWAY,
  CLIENT_SUBMITTAL_POLICY_SCOPES,
  type ClientSubmittalPolicyGateway,
  type ClientSubmittalPolicyScope,
  type StoredPolicyVersionRow,
  clientSubmittalPackageName,
} from './client-submittal-policy.gateway.js';
import {
  type ClientSubmittalPolicyDefinition,
  type ClientSubmittalRequirement,
  type ClientSubmittalRequirementKey,
  type Disposition,
  type OverrideClass,
  type OverridePolicy,
  checksumDefinition,
  isClientSubmittalPolicyDefinition,
} from './client-submittal-vocab.js';
import { floorViolation, joinFloor } from './client-submittal-floor.js';
import {
  CLIENT_SUBMITTAL_ACTION,
  CLIENT_SUBMITTAL_RESOURCE,
  compileEffectivePackage,
} from './client-submittal-compiler.js';

export interface ClientSubmittalScopeContext {
  readonly company_id: string | null;
  readonly requisition_id: string | null;
}

export interface EffectiveLayerRef {
  readonly scope: ClientSubmittalPolicyScope;
  readonly scope_ref: string | null;
  readonly package_name: string;
  readonly version: string;
  readonly checksum: string;
}

export interface ResolvedClientSubmittalPolicy {
  readonly requirements: readonly ClientSubmittalRequirement[];
  readonly layers: readonly EffectiveLayerRef[];
  readonly composite_version: string;
}

/** The scope layer a requirement's effective value was defined at (read-side). */
export interface RequirementSourceRef {
  readonly scope: ClientSubmittalPolicyScope;
  readonly scope_ref: string | null;
  readonly package_name: string;
  readonly version: string;
  readonly checksum: string;
}

/** Per-requirement provenance flags (§6/§7) — backend truth, never FE-inferred. */
export interface RequirementProvenance {
  /** Effective value comes straight from the TENANT layer (not overridden below). */
  readonly inherited: boolean;
  /** A deeper scope changed a key the TENANT layer also declared. */
  readonly client_override: boolean;
  /** A deeper scope introduced a key the TENANT layer did not declare. */
  readonly client_added: boolean;
  /** The key is FLOOR-constrained by the TENANT layer (non-relaxable at client scope). */
  readonly tenant_floor: boolean;
}

/** An effective requirement annotated with its source layer + provenance (§7). */
export interface EffectiveRequirementView {
  readonly key: ClientSubmittalRequirementKey;
  readonly effective: {
    readonly disposition: Disposition;
    readonly override_class: OverrideClass;
    readonly override_policy: OverridePolicy;
  };
  readonly source: RequirementSourceRef;
  readonly provenance: RequirementProvenance;
}

/** The read-side effective policy: annotated requirements + immutable layer identity (§9). */
export interface EffectivePolicyView {
  readonly requirements: readonly EffectiveRequirementView[];
  readonly layers: readonly EffectiveLayerRef[];
  readonly composite_version: string;
}

/** One raw (unmerged) policy layer (§8) — the client renders inherit/override deltas from these. */
export interface PolicyLayerView {
  readonly scope: ClientSubmittalPolicyScope;
  readonly scope_ref: string | null;
  readonly package_name: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly checksum: string | null;
  readonly effective_from: string | null;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly requirements: readonly ClientSubmittalRequirement[];
}

/** The raw per-layer read (§8): each scope's own definition, plus the merged effective. */
export interface PolicyLayersView {
  readonly tenant: PolicyLayerView;
  readonly client: PolicyLayerView | null;
  readonly requisition: PolicyLayerView | null;
  readonly effective: EffectivePolicyView | null;
}

/** One immutable published version in the history read (§10). */
export interface PolicyVersionHistoryEntry {
  readonly version: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly published_at: string;
  readonly published_by: string;
  readonly checksum: string;
  readonly status: 'current' | 'scheduled' | 'superseded';
}

interface MergeEntry {
  readonly req: ClientSubmittalRequirement;
  readonly view: EffectiveRequirementView;
}

@Injectable()
export class ClientSubmittalPolicyService {
  constructor(
    @Inject(CLIENT_SUBMITTAL_POLICY_GATEWAY) private readonly gateway: ClientSubmittalPolicyGateway,
  ) {}

  private specsFor(ctx: ClientSubmittalScopeContext): Array<{
    scope: ClientSubmittalPolicyScope;
    ref: string | null;
    pkg: string;
  }> {
    const specs: Array<{ scope: ClientSubmittalPolicyScope; ref: string | null; pkg: string }> = [
      { scope: 'TENANT', ref: null, pkg: clientSubmittalPackageName('TENANT', null) },
    ];
    if (ctx.company_id != null) {
      specs.push({ scope: 'CLIENT', ref: ctx.company_id, pkg: clientSubmittalPackageName('CLIENT', ctx.company_id) });
    }
    if (ctx.requisition_id != null) {
      specs.push({
        scope: 'REQUISITION',
        ref: ctx.requisition_id,
        pkg: clientSubmittalPackageName('REQUISITION', ctx.requisition_id),
      });
    }
    return specs;
  }

  /**
   * The single authoritative merge of the active TENANT -> CLIENT -> REQUISITION layers
   * (least-specific first; a more-specific layer OVERRIDES the same requirement key and
   * AUGMENTS new keys). FLOOR is enforced fail-closed during the merge. Produces both the
   * raw merged requirements (decision path) and the annotated per-requirement provenance
   * view (read/admin path) so the two never diverge. Returns null when no layer is active.
   */
  private async mergeLayers(
    tenantId: string,
    ctx: ClientSubmittalScopeContext,
    at: Date,
  ): Promise<{ layers: EffectiveLayerRef[]; entries: MergeEntry[] } | null> {
    const specs = this.specsFor(ctx);
    const rows = await this.gateway.findVersionRows(tenantId, specs.map((s) => s.pkg));

    const entries = new Map<string, MergeEntry>();
    const floors = new Map<string, ClientSubmittalRequirement>();
    const tenantKeys = new Set<string>();
    const tenantFloorKeys = new Set<string>();
    const layers: EffectiveLayerRef[] = [];

    for (const scope of CLIENT_SUBMITTAL_POLICY_SCOPES) {
      const spec = specs.find((s) => s.scope === scope);
      if (spec === undefined) continue;
      const active = selectEffectiveAt(rows.filter((r) => r.package_name === spec.pkg), at);
      if (active === undefined) continue;
      const def = this.decode(active);
      const layerRef: EffectiveLayerRef = {
        scope,
        scope_ref: spec.ref,
        package_name: spec.pkg,
        version: active.version,
        checksum: active.checksum,
      };
      for (const req of def.requirements) {
        const inherited = floors.get(req.key);
        if (inherited !== undefined) {
          const violated = floorViolation(req, inherited);
          if (violated !== null) {
            throw this.invalid(`requirement ${req.key} at scope ${scope} weakens an inherited FLOOR on ${violated}`, {
              reason: 'FLOOR_VIOLATION',
              requirement_key: req.key,
              scope,
              dimension: violated,
            });
          }
          floors.set(req.key, joinFloor(inherited, req));
        } else if (req.override_policy === 'FLOOR') {
          floors.set(req.key, req);
        }
        if (scope === 'TENANT') {
          tenantKeys.add(req.key);
          if (req.override_policy === 'FLOOR') tenantFloorKeys.add(req.key);
        }
        entries.set(req.key, { req, view: this.annotate(req, layerRef, tenantKeys, tenantFloorKeys) });
      }
      layers.push(layerRef);
    }

    if (layers.length === 0) return null;
    // Provenance is correct on the single pass: TENANT is processed FIRST (canonical
    // order), so tenantKeys/tenantFloorKeys are complete before any deeper scope is
    // annotated, and a key overridden deeper simply replaces its TENANT entry.
    return { layers, entries: [...entries.values()] };
  }

  private annotate(
    req: ClientSubmittalRequirement,
    source: EffectiveLayerRef,
    tenantKeys: ReadonlySet<string>,
    tenantFloorKeys: ReadonlySet<string>,
  ): EffectiveRequirementView {
    const fromTenant = source.scope === 'TENANT';
    const tenantHadKey = fromTenant || tenantKeys.has(req.key);
    return {
      key: req.key,
      effective: {
        disposition: req.disposition,
        override_class: req.override_class,
        override_policy: req.override_policy,
      },
      source: {
        scope: source.scope,
        scope_ref: source.scope_ref,
        package_name: source.package_name,
        version: source.version,
        checksum: source.checksum,
      },
      provenance: {
        inherited: fromTenant,
        client_override: !fromTenant && tenantHadKey,
        client_added: !fromTenant && !tenantHadKey,
        tenant_floor: fromTenant ? req.override_policy === 'FLOOR' : tenantFloorKeys.has(req.key),
      },
    };
  }

  /**
   * Resolve the effective Client Submittal Policy for a (company, requisition) context.
   * The decision path's authoritative read — its return shape is intentionally frozen
   * (the submit command depends on it). Returns null when no layer has an active policy.
   */
  async resolveEffective(
    tenantId: string,
    ctx: ClientSubmittalScopeContext,
    at: Date = new Date(),
  ): Promise<ResolvedClientSubmittalPolicy | null> {
    const merged = await this.mergeLayers(tenantId, ctx, at);
    if (merged === null) return null;
    return {
      requirements: merged.entries.map((e) => e.req),
      layers: merged.layers,
      composite_version: compositeVersion(merged.layers),
    };
  }

  /**
   * The read/admin effective view (§7/§9): the same authoritative merge, annotated with
   * per-requirement source layer + provenance flags. Never used by the decision path.
   */
  async resolveEffectiveView(
    tenantId: string,
    ctx: ClientSubmittalScopeContext,
    at: Date = new Date(),
  ): Promise<EffectivePolicyView | null> {
    const merged = await this.mergeLayers(tenantId, ctx, at);
    if (merged === null) return null;
    return {
      requirements: merged.entries.map((e) => e.view),
      layers: merged.layers,
      composite_version: compositeVersion(merged.layers),
    };
  }

  /**
   * The raw per-layer read (§8): each scope's OWN active definition (unmerged) plus the
   * merged effective view. Powers the editor's inherit/override toggles and the
   * "Tenant: X -> Client: Y" delta without the FE reconstructing policy semantics.
   */
  async readLayers(
    tenantId: string,
    ctx: ClientSubmittalScopeContext,
    at: Date = new Date(),
  ): Promise<PolicyLayersView> {
    const specs = this.specsFor(ctx);
    const rows = await this.gateway.findVersionRows(tenantId, specs.map((s) => s.pkg));
    const layerFor = (scope: ClientSubmittalPolicyScope): PolicyLayerView => {
      const spec = specs.find((s) => s.scope === scope);
      const pkg = spec?.pkg ?? clientSubmittalPackageName(scope, null);
      const ref = spec?.ref ?? null;
      const active = spec === undefined ? undefined : selectEffectiveAt(rows.filter((r) => r.package_name === pkg), at);
      if (active === undefined) {
        return {
          scope, scope_ref: ref, package_name: pkg, present: false,
          version: null, checksum: null, effective_from: null, published_at: null, published_by: null,
          requirements: [],
        };
      }
      return {
        scope, scope_ref: ref, package_name: pkg, present: true,
        version: active.version, checksum: active.checksum,
        effective_from: active.effective_from.toISOString(),
        published_at: active.published_at.toISOString(),
        published_by: active.published_by,
        requirements: this.decode(active).requirements,
      };
    };
    return {
      tenant: layerFor('TENANT'),
      client: ctx.company_id != null ? layerFor('CLIENT') : null,
      requisition: ctx.requisition_id != null ? layerFor('REQUISITION') : null,
      effective: await this.resolveEffectiveView(tenantId, ctx, at),
    };
  }

  /**
   * The version history for a single policy scope (§10), newest first, each with an
   * immutable checksum and a computed lifecycle status. Read-only — history is never
   * edited in place; a change is a new published version.
   */
  async history(
    tenantId: string,
    scope: ClientSubmittalPolicyScope,
    scopeRef: string | null,
    at: Date = new Date(),
  ): Promise<PolicyVersionHistoryEntry[]> {
    const pkg = clientSubmittalPackageName(scope, scopeRef);
    const rows = await this.gateway.findVersionRows(tenantId, [pkg]);
    return rows
      .filter((r) => r.package_name === pkg)
      .slice()
      .sort((a, b) => b.effective_from.getTime() - a.effective_from.getTime())
      .map((r) => ({
        version: r.version,
        effective_from: r.effective_from.toISOString(),
        effective_to: r.effective_to === null ? null : r.effective_to.toISOString(),
        published_at: r.published_at.toISOString(),
        published_by: r.published_by,
        checksum: r.checksum,
        status: historyStatus(r, at),
      }));
  }

  /** Compile the effective definition to a generic PolicyPackage (compile only, no decision). */
  compile(effective: ResolvedClientSubmittalPolicy) {
    return compileEffectivePackage({ requirements: effective.requirements }, effective.composite_version);
  }

  /**
   * Decide a submit against the effective policy: compile ONCE to a generic
   * PolicyPackage, then evaluate the supplied facts via the pure generic engine.
   * The command supplies the facts (resource_state.derived); the engine never
   * fetches them.
   */
  decide(
    tenantId: string,
    effective: ResolvedClientSubmittalPolicy,
    facts: Readonly<Record<string, unknown>>,
    correlationId: string,
    origin: PolicyContext['request_metadata']['origin'] = 'ui',
  ): PolicyDecision {
    const pkg = this.compile(effective);
    const context: PolicyContext = {
      tenant_id: tenantId,
      resource: CLIENT_SUBMITTAL_RESOURCE,
      action: CLIENT_SUBMITTAL_ACTION,
      resource_state: { declared: {}, derived: facts },
      principal_capabilities: {},
      request_metadata: { correlation_id: correlationId, origin },
      environment: 'production',
      time: new Date().toISOString(),
      attributes: {},
    };
    return evaluate(pkg, context);
  }

  /**
   * Publish a new immutable version at a scope. Validates the definition, computes
   * the checksum, and delegates the atomic write to the gateway. A CLIENT publish
   * runs the publish-time EARLY floor guard against the currently-published TENANT
   * floors (a UX/safety improvement only — resolveEffective remains the
   * authoritative fail-closed guard).
   */
  async publish(input: {
    readonly tenant_id: string;
    readonly scope: ClientSubmittalPolicyScope;
    readonly scope_ref: string | null;
    readonly version: string;
    readonly definition: unknown;
    readonly published_by: string;
    readonly effective_from?: Date;
  }): Promise<StoredPolicyVersionRow> {
    if (!isClientSubmittalPolicyDefinition(input.definition)) {
      throw this.invalid('client-submittal-policy definition is malformed', { reason: 'MALFORMED_DEFINITION' });
    }
    const definition = input.definition;
    if (input.scope === 'CLIENT') {
      const tenantFloors = await this.publishedTenantFloors(input.tenant_id);
      for (const r of definition.requirements) {
        const floor = tenantFloors.get(r.key);
        if (floor === undefined) continue;
        const violated = floorViolation(r, floor);
        if (violated !== null) {
          throw this.invalid(`CLIENT set weakens the TENANT FLOOR for ${r.key} on ${violated}`, {
            reason: 'FLOOR_VIOLATION',
            requirement_key: r.key,
            scope: 'CLIENT',
            dimension: violated,
          });
        }
      }
    }
    return this.gateway.insertVersion({
      tenant_id: input.tenant_id,
      package_name: clientSubmittalPackageName(input.scope, input.scope_ref),
      version: input.version,
      definition,
      checksum: checksumDefinition(definition),
      effective_from: input.effective_from ?? new Date(),
      published_by: input.published_by,
    });
  }

  private async publishedTenantFloors(tenantId: string): Promise<Map<string, ClientSubmittalRequirement>> {
    const pkg = clientSubmittalPackageName('TENANT', null);
    const rows = await this.gateway.findVersionRows(tenantId, [pkg]);
    const active = selectEffectiveAt(
      rows.filter((r) => r.package_name === pkg),
      new Date(),
    );
    const floors = new Map<string, ClientSubmittalRequirement>();
    if (active === undefined) return floors;
    for (const r of this.decode(active).requirements) {
      if (r.override_policy === 'FLOOR') floors.set(r.key, r);
    }
    return floors;
  }

  private decode(row: StoredPolicyVersionRow): ClientSubmittalPolicyDefinition {
    if (!isClientSubmittalPolicyDefinition(row.definition)) {
      throw this.invalid('stored client-submittal-policy definition is malformed', {
        reason: 'MALFORMED_DEFINITION',
        package_name: row.package_name,
      });
    }
    const expected = checksumDefinition(row.definition);
    if (expected !== row.checksum) {
      throw this.invalid('client-submittal-policy checksum mismatch (fail-closed)', {
        reason: 'CHECKSUM_MISMATCH',
        package_name: row.package_name,
      });
    }
    return row.definition;
  }

  private invalid(message: string, details: Record<string, unknown>): AramoError {
    return new AramoError('CLIENT_SUBMITTAL_POLICY_INVALID', message, 422, { requestId: 'client-submittal-policy', details });
  }
}

// Deterministic composite identity of the effective policy, derived purely from the
// immutable per-layer (scope, version, checksum) triples in canonical
// TENANT->CLIENT->REQUISITION order. No wall-clock, no resolution-order dependence
// beyond the canonical order.
function compositeVersion(layers: readonly EffectiveLayerRef[]): string {
  return layers.map((l) => `${l.scope}:${l.version}:${l.checksum.slice(0, 12)}`).join('|');
}

// A stored version's lifecycle status at a read instant: scheduled (window not yet
// open), current (open window covering `at`), superseded (window already closed).
function historyStatus(
  row: { effective_from: Date; effective_to: Date | null },
  at: Date,
): PolicyVersionHistoryEntry['status'] {
  if (row.effective_from.getTime() > at.getTime()) return 'scheduled';
  if (row.effective_to === null || row.effective_to.getTime() > at.getTime()) return 'current';
  return 'superseded';
}
