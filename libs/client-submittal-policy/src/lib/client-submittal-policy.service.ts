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

@Injectable()
export class ClientSubmittalPolicyService {
  constructor(
    @Inject(CLIENT_SUBMITTAL_POLICY_GATEWAY) private readonly gateway: ClientSubmittalPolicyGateway,
  ) {}

  /**
   * Resolve the effective Client Submittal Policy for a (company, requisition)
   * context by merging the active TENANT -> CLIENT -> REQUISITION layers
   * (least-specific first; a more-specific layer OVERRIDES the same requirement key
   * and AUGMENTS new keys). FLOOR is enforced during the merge, fail-closed: a more-
   * specific layer may not weaken an inherited FLOOR requirement, and any
   * strengthening RAISES the effective floor for deeper layers. Returns null when no
   * layer has an active published policy.
   */
  async resolveEffective(
    tenantId: string,
    ctx: ClientSubmittalScopeContext,
    at: Date = new Date(),
  ): Promise<ResolvedClientSubmittalPolicy | null> {
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

    const rows = await this.gateway.findVersionRows(tenantId, specs.map((s) => s.pkg));

    const merged = new Map<string, ClientSubmittalRequirement>();
    const floors = new Map<string, ClientSubmittalRequirement>();
    const layers: EffectiveLayerRef[] = [];

    // Least-specific first (canonical scope order), so a more-specific layer applied
    // later overrides the same requirement key.
    for (const scope of CLIENT_SUBMITTAL_POLICY_SCOPES) {
      const spec = specs.find((s) => s.scope === scope);
      if (spec === undefined) continue;
      const active = selectEffectiveAt(
        rows.filter((r) => r.package_name === spec.pkg),
        at,
      );
      if (active === undefined) continue;
      const def = this.decode(active);
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
        merged.set(req.key, req);
      }
      layers.push({
        scope,
        scope_ref: spec.ref,
        package_name: spec.pkg,
        version: active.version,
        checksum: active.checksum,
      });
    }

    if (layers.length === 0) return null;

    return {
      requirements: [...merged.values()],
      layers,
      composite_version: compositeVersion(layers),
    };
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
