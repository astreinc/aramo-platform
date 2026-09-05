import { Inject, Injectable } from '@nestjs/common';
import { checksumMatches, computeChecksum, selectEffectiveAt } from '@aramo/policy-store';

import {
  ENGAGEMENT_POLICY_SCOPES,
  requirementKey,
  type EngagementChannel,
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
  async resolveEffective(
    tenantId: string,
    ctx: EngagementScopeContext,
    at: Date = new Date(),
  ): Promise<ResolvedEngagementPolicy | null> {
    const specs: Array<{ scope: EngagementPolicyScope; ref: string | null; pkg: string }> = [
      { scope: 'TENANT', ref: null, pkg: engagementPackageName('TENANT', null) },
    ];
    if (ctx.company_id != null) {
      specs.push({ scope: 'CLIENT', ref: ctx.company_id, pkg: engagementPackageName('CLIENT', ctx.company_id) });
    }
    if (ctx.requisition_id != null) {
      specs.push({ scope: 'REQUISITION', ref: ctx.requisition_id, pkg: engagementPackageName('REQUISITION', ctx.requisition_id) });
    }

    const rows = await this.gateway.findVersionRows(tenantId, specs.map((s) => s.pkg));

    const merged = new Map<EngagementChannel, EngagementRequirement>();
    const layers: EngagementPolicyLayerRef[] = [];

    // Least-specific first (ENGAGEMENT_POLICY_SCOPES order) so a more-specific
    // layer, applied later, overwrites the same channel key.
    for (const scope of ENGAGEMENT_POLICY_SCOPES) {
      const spec = specs.find((s) => s.scope === scope);
      if (spec === undefined) continue;
      const active = selectEffectiveAt(
        rows.filter((r) => r.package_name === spec.pkg),
        at,
      );
      if (active === undefined) continue;
      const def = decodeDefinition(active);
      for (const req of def.requirements) merged.set(requirementKey(req), req);
      layers.push({ scope, package_name: spec.pkg, version: active.version, checksum: active.checksum });
    }

    if (layers.length === 0) return null;

    return {
      requirements: [...merged.values()],
      layers,
      composite_version: layers.map((l) => `${l.scope}:${l.version}:${l.checksum.slice(0, 12)}`).join('|'),
    };
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
