import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CompanyModule } from '@aramo/company';
import { SettingsModule } from '@aramo/settings';
import {
  IdentityModule,
  TENANT_COGNITO_PORT,
  StubTenantCognitoAdapter,
  AUDIT_FINANCIALS_GATE,
  StubAuditFinancialsGateAdapter,
  TenantUserLifecycleService,
} from '@aramo/identity';

import { TenantCognitoAdapter } from '../cognito/tenant-cognito.adapter.js';
import { AuditFinancialsGateAdapter } from '../settings/audit-financials-gate.adapter.js';

// Aramo-Auth-IdentityModule-Split-Directive-v1_0-LOCKED §4 — the DI-resolution
// proof that REPRODUCES the multi-instance stub collision the three prior
// binding-fix specs could not catch.
//
// WHY THE PRIOR SPECS MISSED IT: cognito-binding.di.spec.ts /
// financials-gate-binding.di.spec.ts boot `IdentityModule.forRoot(...)` IN
// ISOLATION. In isolation there is no STATIC importer of IdentityModule, so
// NestJS 11's ByReferenceModuleOpaqueKeyFactory never mints a second module
// instance — the forRoot (real-bound) instance is the only one, and the bare
// `container.get(token)` resolves it. Those specs were unit-GREEN while PROD
// was BROKEN.
//
// WHAT THIS SPEC DOES DIFFERENTLY: it boots BOTH a real static importer
// (CompanyModule — the earliest static `imports: [IdentityModule]` in the
// apps/api graph, app.module:76, the one that wins the invite route in PROD)
// AND `IdentityModule.forRoot({ real adapters })` together — exactly the
// production collision. It then resolves THROUGH the route-serving surface
// (every TenantUserManagementController and every TenantUserLifecycleService
// instance in the graph, NOT a bare token lookup that could mask a second
// instance), and asserts EVERY such instance holds the REAL adapters.
//
// PRE-SPLIT: CompanyModule pulls a 2nd (stub-bound) IdentityModule instance →
//   one of the lifecycle-service instances carries StubTenantCognitoAdapter →
//   this spec FAILS (the documented red — it reproduces the defect).
// POST-SPLIT: CompanyModule imports IdentityCoreModule (no cognito port, no
//   lifecycle service, no invite controller); the lifecycle service +
//   controller + ports exist ONLY in the single forRoot IdentityModule →
//   every instance holds the real adapter → this spec PASSES (green).
//
// DB-free + AWS-free: only compile() runs (constructs singletons; no
// onModuleInit, so no Postgres $connect; the real TenantCognitoAdapter builds
// its SDK client without any network call). The real adapters are the SAME
// classes apps/api binds in production — so this proves the production wiring,
// not a fake stand-in.

interface PortHolder {
  cognito: unknown;
  auditFinancialsGate: unknown;
}

// Walk the entire DI container and collect every instance of `metatype`
// across ALL module instances (the multi-instance condition means a token can
// resolve to more than one object — a bare moduleRef.get() would hide that).
function collectProviderInstances<T>(
  moduleRef: { container: { getModules(): Map<unknown, unknown> } },
  metatype: unknown,
): T[] {
  const found: T[] = [];
  for (const mod of moduleRef.container.getModules().values()) {
    const wrapper = (mod as { providers: Map<unknown, { instance?: unknown }> })
      .providers.get(metatype);
    if (wrapper?.instance !== undefined && wrapper.instance !== null) {
      found.push(wrapper.instance as T);
    }
  }
  return found;
}

function collectControllerInstancesByName(
  moduleRef: { container: { getModules(): Map<unknown, unknown> } },
  name: string,
): unknown[] {
  const found: unknown[] = [];
  for (const mod of moduleRef.container.getModules().values()) {
    const controllers = (
      mod as {
        controllers: Map<unknown, { instance?: unknown; metatype?: { name?: string } }>;
      }
    ).controllers;
    for (const wrapper of controllers.values()) {
      if (
        wrapper.metatype?.name === name &&
        wrapper.instance !== undefined &&
        wrapper.instance !== null
      ) {
        found.push(wrapper.instance);
      }
    }
  }
  return found;
}

describe('IdentityModule split — invite ports resolve REAL adapters in the multi-instance graph', () => {
  async function bootCollidingGraph() {
    return Test.createTestingModule({
      imports: [
        // Real static importer — reproduces the PROD second-instance condition.
        CompanyModule,
        // The production forRoot binding (real adapters, SettingsModule threaded
        // for AuditFinancialsGateAdapter's TenantSettingService injection).
        IdentityModule.forRoot({
          cognitoAdapter: TenantCognitoAdapter,
          auditFinancialsGate: AuditFinancialsGateAdapter,
          imports: [SettingsModule],
        }),
      ],
    }).compile();
  }

  it('every TenantUserLifecycleService in the graph holds the REAL cognito + financials adapters (no stub)', async () => {
    const moduleRef = (await bootCollidingGraph()) as unknown as {
      container: { getModules(): Map<unknown, unknown> };
    };

    const services = collectProviderInstances<PortHolder>(
      moduleRef,
      TenantUserLifecycleService,
    );

    // Sanity: the consumer must exist in the graph at all.
    expect(services.length).toBeGreaterThan(0);

    for (const svc of services) {
      // Resolve THROUGH the consumer (its injected port), not a bare token get.
      expect(svc.cognito).toBeInstanceOf(TenantCognitoAdapter);
      expect(svc.cognito).not.toBeInstanceOf(StubTenantCognitoAdapter);
      expect(svc.auditFinancialsGate).toBeInstanceOf(AuditFinancialsGateAdapter);
      expect(svc.auditFinancialsGate).not.toBeInstanceOf(
        StubAuditFinancialsGateAdapter,
      );
    }
  });

  it('the invite controller (TenantUserManagementController) delegates to a REAL-bound lifecycle service', async () => {
    const moduleRef = (await bootCollidingGraph()) as unknown as {
      container: { getModules(): Map<unknown, unknown> };
    };

    const controllers = collectControllerInstancesByName(
      moduleRef,
      'TenantUserManagementController',
    );
    expect(controllers.length).toBeGreaterThan(0);

    for (const ctrl of controllers) {
      const lifecycle = (ctrl as { lifecycle: PortHolder }).lifecycle;
      expect(lifecycle.cognito).toBeInstanceOf(TenantCognitoAdapter);
      expect(lifecycle.cognito).not.toBeInstanceOf(StubTenantCognitoAdapter);
    }
  });

  it('no StubTenantCognitoAdapter / StubAuditFinancialsGateAdapter is instantiated anywhere in the graph', async () => {
    const moduleRef = (await bootCollidingGraph()) as unknown as {
      container: { getModules(): Map<unknown, unknown> };
    };

    const cognitoBindings = collectProviderInstances<unknown>(
      moduleRef,
      TENANT_COGNITO_PORT,
    );
    const financialsBindings = collectProviderInstances<unknown>(
      moduleRef,
      AUDIT_FINANCIALS_GATE,
    );

    expect(cognitoBindings.length).toBeGreaterThan(0);
    for (const b of cognitoBindings) {
      expect(b).not.toBeInstanceOf(StubTenantCognitoAdapter);
    }
    for (const b of financialsBindings) {
      expect(b).not.toBeInstanceOf(StubAuditFinancialsGateAdapter);
    }
  });
});
