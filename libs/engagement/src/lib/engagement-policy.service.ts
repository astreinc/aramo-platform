import { Inject, Injectable } from '@nestjs/common';
import { checksumMatches, computeChecksum, selectEffectiveAt } from '@aramo/policy-store';

import {
  DEFAULT_ENGAGEMENT_ENFORCEMENT_MODE,
  ENGAGEMENT_POLICY_SCOPES,
  requirementKey,
  type EngagementChannel,
  type EngagementEnforcementMode,
  type EngagementPolicyDefinition,
  type EngagementPolicyScope,
  type EngagementRequirement,
} from './domain/engagement-vocab.js';
import {
  assertEngagementPolicyActivatable,
  EngagementPolicyValidationError,
  validateEngagementPolicyDefinition,
} from './domain/engagement-policy-validation.js';
import { evidenceCapabilities, type ChannelEvidenceCapability } from './domain/evidence-capability.js';
import type { ResolvedEngagementRequirements } from './domain/engagement-readiness.js';
import {
  ENGAGEMENT_POLICY_GATEWAY,
  engagementPackageName,
  type EngagementPolicyGateway,
  type StoredPolicyVersionRow,
} from './engagement-policy.gateway.js';

// COMM-C3 — engagement-policy domain service (directive C3-2/C3-4/R7/R11). Owns
// definition validation + the R7 activation guard on publish, and the layered
// TENANT→CLIENT→REQUISITION effective-policy resolution (merge implemented HERE,
// not imported from pre-start). Raw persistence is the injected gateway (R12/R13);
// this service is provider-neutral and reads no communication evidence.

export interface EngagementPolicyLayerRef {
  readonly scope: EngagementPolicyScope;
  readonly package_name: string;
  readonly version: string;
  readonly checksum: string;
}

export interface ResolvedEngagementPolicy extends ResolvedEngagementRequirements {
  readonly requirements: readonly EngagementRequirement[];
  readonly layers: readonly EngagementPolicyLayerRef[];
  /** Composite version+checksum over the contributing layers (audit provenance). */
  readonly composite_version: string;
  /**
   * The resolved effective enforcement mode (PART A). The most-specific
   * contributing layer's mode wins; a layer with no explicit mode defaults to
   * ENFORCING (A2 backward-compat — a legacy policy is never ADVISORY).
   */
  readonly enforcement_mode: EngagementEnforcementMode;
}

export interface EngagementScopeContext {
  readonly company_id?: string | null;
  readonly requisition_id?: string | null;
}

export interface PublishEngagementPolicyInput {
  readonly tenant_id: string;
  readonly version: string;
  readonly definition: EngagementPolicyDefinition;
  readonly published_by: string;
  readonly effective_from?: Date;
}

export interface PublishedEngagementPolicy {
  readonly package_name: string;
  readonly scope: EngagementPolicyScope;
  readonly scope_ref: string | null;
  readonly version: string;
  readonly checksum: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly published_by: string;
  readonly published_at: string;
}

// CSP PA-2b — read-side provenance for the admin FE. Engagement is CHANNEL-keyed and
// has NO per-requirement FLOOR (§19 — parity is not faked): provenance carries
// inherited / client_override / client_added only. Runtime-override authority is the
// POLICY-level enforcement_mode, not a per-requirement class.
export interface EngagementRequirementProvenance {
  readonly inherited: boolean;
  readonly client_override: boolean;
  readonly client_added: boolean;
}
export interface EffectiveEngagementRequirementView {
  readonly channel: EngagementChannel;
  readonly requirement: EngagementRequirement;
  readonly source: {
    readonly scope: EngagementPolicyScope;
    readonly scope_ref: string | null;
    readonly package_name: string;
    readonly version: string;
    readonly checksum: string;
  };
  readonly provenance: EngagementRequirementProvenance;
}
export interface EffectiveEngagementView {
  readonly requirements: readonly EffectiveEngagementRequirementView[];
  readonly layers: readonly EngagementPolicyLayerRef[];
  readonly composite_version: string;
  readonly enforcement_mode: EngagementEnforcementMode;
}
/** One raw (unmerged) engagement layer for the editor's inherit/override deltas (§8). */
export interface EngagementLayerView {
  readonly scope: EngagementPolicyScope;
  readonly scope_ref: string | null;
  readonly package_name: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly checksum: string | null;
  readonly effective_from: string | null;
  readonly published_at: string | null;
  readonly published_by: string | null;
  readonly enforcement_mode: EngagementEnforcementMode | null;
  readonly requirements: readonly EngagementRequirement[];
}
export interface EngagementLayersView {
  readonly tenant: EngagementLayerView;
  readonly client: EngagementLayerView | null;
  readonly requisition: EngagementLayerView | null;
  readonly effective: EffectiveEngagementView | null;
}
/** One immutable published version in the history read (§10). */
export interface EngagementHistoryEntry {
  readonly version: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly published_at: string;
  readonly published_by: string;
  readonly checksum: string;
  readonly status: 'current' | 'scheduled' | 'superseded';
}

interface EngagementMergeEntry {
  readonly requirement: EngagementRequirement;
  readonly source: EffectiveEngagementRequirementView['source'];
}

@Injectable()
export class EngagementPolicyService {
  constructor(
    @Inject(ENGAGEMENT_POLICY_GATEWAY) private readonly gateway: EngagementPolicyGateway,
  ) {}

  /** Publish a new engagement-policy version (validated + activation-guarded, R7). */
  async publish(input: PublishEngagementPolicyInput): Promise<PublishedEngagementPolicy> {
    validateEngagementPolicyDefinition(input.definition);
    assertEngagementPolicyActivatable(input.definition);
    const def = input.definition;
    const packageName = engagementPackageName(def.scope, def.scope_ref);
    const row = await this.gateway.insertVersion({
      tenant_id: input.tenant_id,
      package_name: packageName,
      version: input.version,
      definition: def,
      checksum: computeChecksum(def),
      effective_from: input.effective_from ?? new Date(),
      published_by: input.published_by,
    });
    return toPublished(row, def.scope, def.scope_ref);
  }

  /** The evidence-capability snapshot (provider-neutral) for admin/readiness surfaces. */
  capabilities(): ChannelEvidenceCapability[] {
    return evidenceCapabilities();
  }

  /**
   * COMM-C3 amendment — whether the tenant is engagement-policy-GOVERNED: it has
   * published at least one engagement policy version (any scope). A never-governed
   * tenant is DORMANT (the gate does not enforce); once governed, a missing
   * effective policy is FAIL-CLOSED and the tenant cannot revert to dormant.
   */
  async isTenantGoverned(tenantId: string): Promise<boolean> {
    return this.gateway.tenantHasAnyEngagementPolicy(tenantId);
  }

  /**
   * Resolve the effective engagement policy for a Talent × Requisition context by
   * merging the active TENANT → CLIENT → REQUISITION layers (least-specific first;
   * a more-specific layer OVERRIDES the same channel and AUGMENTS new channels —
   * R11). Returns null when no layer has an active published policy.
   */
  private specsFor(ctx: EngagementScopeContext): Array<{
    scope: EngagementPolicyScope;
    ref: string | null;
    pkg: string;
  }> {
    const specs: Array<{ scope: EngagementPolicyScope; ref: string | null; pkg: string }> = [
      { scope: 'TENANT', ref: null, pkg: engagementPackageName('TENANT', null) },
    ];
    if (ctx.company_id != null) {
      specs.push({ scope: 'CLIENT', ref: ctx.company_id, pkg: engagementPackageName('CLIENT', ctx.company_id) });
    }
    if (ctx.requisition_id != null) {
      specs.push({ scope: 'REQUISITION', ref: ctx.requisition_id, pkg: engagementPackageName('REQUISITION', ctx.requisition_id) });
    }
    return specs;
  }

  // CSP PA-2b — the SINGLE authoritative TENANT→CLIENT→REQUISITION channel merge,
  // tracking per-channel source scope + which channels the TENANT layer declared, so the
  // decision path (resolveEffective) and the read/admin path never diverge.
  private async mergeLayers(
    tenantId: string,
    ctx: EngagementScopeContext,
    at: Date,
  ): Promise<{
    layers: EngagementPolicyLayerRef[];
    entries: Map<EngagementChannel, EngagementMergeEntry>;
    tenantChannels: Set<EngagementChannel>;
    enforcementMode: EngagementEnforcementMode;
  } | null> {
    const specs = this.specsFor(ctx);
    const rows = await this.gateway.findVersionRows(tenantId, specs.map((s) => s.pkg));

    const entries = new Map<EngagementChannel, EngagementMergeEntry>();
    const tenantChannels = new Set<EngagementChannel>();
    const layers: EngagementPolicyLayerRef[] = [];
    let enforcementMode: EngagementEnforcementMode = DEFAULT_ENGAGEMENT_ENFORCEMENT_MODE;

    for (const scope of ENGAGEMENT_POLICY_SCOPES) {
      const spec = specs.find((s) => s.scope === scope);
      if (spec === undefined) continue;
      const active = selectEffectiveAt(rows.filter((r) => r.package_name === spec.pkg), at);
      if (active === undefined) continue;
      const def = decodeDefinition(active);
      const source: EffectiveEngagementRequirementView['source'] = {
        scope, scope_ref: spec.ref, package_name: spec.pkg, version: active.version, checksum: active.checksum,
      };
      for (const req of def.requirements) {
        const key = requirementKey(req);
        if (scope === 'TENANT') tenantChannels.add(key);
        entries.set(key, { requirement: req, source });
      }
      enforcementMode = def.enforcement_mode ?? DEFAULT_ENGAGEMENT_ENFORCEMENT_MODE;
      layers.push({ scope, package_name: spec.pkg, version: active.version, checksum: active.checksum });
    }

    if (layers.length === 0) return null;
    return { layers, entries, tenantChannels, enforcementMode };
  }

  /**
   * Resolve the effective engagement policy for a Talent × Requisition context
   * (R11). The decision path's authoritative read — its return shape is intentionally
   * frozen. Returns null when no layer has an active published policy.
   */
  async resolveEffective(
    tenantId: string,
    ctx: EngagementScopeContext,
    at: Date = new Date(),
  ): Promise<ResolvedEngagementPolicy | null> {
    const merged = await this.mergeLayers(tenantId, ctx, at);
    if (merged === null) return null;
    return {
      requirements: [...merged.entries.values()].map((e) => e.requirement),
      layers: merged.layers,
      composite_version: merged.layers.map((l) => `${l.scope}:${l.version}:${l.checksum.slice(0, 12)}`).join('|'),
      enforcement_mode: merged.enforcementMode,
    };
  }

  /**
   * The read/admin effective view (§7/§9/§19): the same merge, each channel requirement
   * annotated with its source layer + provenance (inherited / client_override /
   * client_added — engagement has no per-requirement floor). Never used by the gate.
   */
  async resolveEffectiveView(
    tenantId: string,
    ctx: EngagementScopeContext,
    at: Date = new Date(),
  ): Promise<EffectiveEngagementView | null> {
    const merged = await this.mergeLayers(tenantId, ctx, at);
    if (merged === null) return null;
    const requirements = [...merged.entries.values()].map((e) => {
      const fromTenant = e.source.scope === 'TENANT';
      const channel = requirementKey(e.requirement);
      const tenantHad = fromTenant || merged.tenantChannels.has(channel);
      return {
        channel,
        requirement: e.requirement,
        source: e.source,
        provenance: {
          inherited: fromTenant,
          client_override: !fromTenant && tenantHad,
          client_added: !fromTenant && !tenantHad,
        },
      };
    });
    return {
      requirements,
      layers: merged.layers,
      composite_version: merged.layers.map((l) => `${l.scope}:${l.version}:${l.checksum.slice(0, 12)}`).join('|'),
      enforcement_mode: merged.enforcementMode,
    };
  }

  /**
   * The raw per-layer read (§8): each scope's OWN definition (unmerged) + its
   * enforcement_mode, plus the merged effective — powers the editor's inherit/override
   * deltas without the FE reconstructing merge semantics.
   */
  async readLayers(
    tenantId: string,
    ctx: EngagementScopeContext,
    at: Date = new Date(),
  ): Promise<EngagementLayersView> {
    const specs = this.specsFor(ctx);
    const rows = await this.gateway.findVersionRows(tenantId, specs.map((s) => s.pkg));
    const layerFor = (scope: EngagementPolicyScope): EngagementLayerView => {
      const spec = specs.find((s) => s.scope === scope);
      const pkg = spec?.pkg ?? engagementPackageName(scope, null);
      const ref = spec?.ref ?? null;
      const active = spec === undefined ? undefined : selectEffectiveAt(rows.filter((r) => r.package_name === pkg), at);
      if (active === undefined) {
        return {
          scope, scope_ref: ref, package_name: pkg, present: false,
          version: null, checksum: null, effective_from: null, published_at: null, published_by: null,
          enforcement_mode: null, requirements: [],
        };
      }
      const def = decodeDefinition(active);
      return {
        scope, scope_ref: ref, package_name: pkg, present: true,
        version: active.version, checksum: active.checksum,
        effective_from: active.effective_from.toISOString(),
        published_at: active.published_at.toISOString(),
        published_by: active.published_by,
        enforcement_mode: def.enforcement_mode ?? DEFAULT_ENGAGEMENT_ENFORCEMENT_MODE,
        requirements: def.requirements,
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
   * The immutable version history for one engagement policy scope (§10), newest first,
   * each with a computed lifecycle status.
   */
  async history(
    tenantId: string,
    scope: EngagementPolicyScope,
    scopeRef: string | null,
    at: Date = new Date(),
  ): Promise<EngagementHistoryEntry[]> {
    const pkg = engagementPackageName(scope, scopeRef);
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
        status:
          r.effective_from.getTime() > at.getTime()
            ? 'scheduled'
            : r.effective_to === null || r.effective_to.getTime() > at.getTime()
              ? 'current'
              : 'superseded',
      }));
  }
}

function decodeDefinition(row: StoredPolicyVersionRow): EngagementPolicyDefinition {
  if (!checksumMatches(row.definition, row.checksum)) {
    throw new EngagementPolicyValidationError(
      'ENGAGEMENT_POLICY_SCHEMA_INVALID',
      `engagement policy ${row.package_name}@${row.version} failed its integrity check`,
    );
  }
  return row.definition as EngagementPolicyDefinition;
}

function toPublished(
  row: StoredPolicyVersionRow,
  scope: EngagementPolicyScope,
  scopeRef: string | null,
): PublishedEngagementPolicy {
  return {
    package_name: row.package_name,
    scope,
    scope_ref: scopeRef,
    version: row.version,
    checksum: row.checksum,
    effective_from: row.effective_from.toISOString(),
    effective_to: row.effective_to === null ? null : row.effective_to.toISOString(),
    published_by: row.published_by,
    published_at: row.published_at.toISOString(),
  };
}
