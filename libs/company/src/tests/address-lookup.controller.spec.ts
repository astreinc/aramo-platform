import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AramoError } from '@aramo/common';
import {
  REQUIRED_SCOPES_KEY,
  REQUIRES_SITE_MATCH_KEY,
  RolesGuard,
} from '@aramo/authorization';
import { REQUIRED_CAPABILITIES_KEY } from '@aramo/entitlement';

import { AddressLookupController } from '../lib/address-lookup.controller.js';
import { AddressLookupService } from '../lib/address-lookup.service.js';
import { CompanyController } from '../lib/company.controller.js';
import type { AddressSuggestionDto } from '../lib/dto/address-suggestion.dto.js';
import type { AddressDetailsDto } from '../lib/dto/address-details.dto.js';

// Address-Autocomplete v1.0 — §4 gates 2 (NEVER-BLOCK / empty-200), 4
// (QUERY-VALIDATION), 5 (TENANT/SCOPE GATE — via guard metadata; the guards
// themselves are exercised by the shared RolesGuard/EntitlementGuard suites,
// identical to CompanyController).

const REQ_ID = 'req-test-1';

// A service that always throws — to prove the controller's never-block catch.
function throwingService(): AddressLookupService {
  return {
    isEnabled: () => true,
    autocomplete: async () => {
      throw new Error('provider-exploded');
    },
    details: async () => {
      throw new Error('provider-exploded');
    },
  } as unknown as AddressLookupService;
}

describe('AddressLookupController — validation', () => {
  const controller = new AddressLookupController(new AddressLookupService());

  it('rejects a <3-char query with VALIDATION_ERROR (400)', async () => {
    await expect(controller.autocomplete('ab', undefined, REQ_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
  });

  it('rejects a blank/missing query with VALIDATION_ERROR', async () => {
    await expect(controller.autocomplete(undefined, undefined, REQ_ID)).rejects.toBeInstanceOf(AramoError);
    await expect(controller.autocomplete('   ', undefined, REQ_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects an over-long query', async () => {
    const long = 'a'.repeat(201);
    await expect(controller.autocomplete(long, undefined, REQ_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'query_too_long' } },
    });
  });

  it('rejects a blank place_id on /details', async () => {
    await expect(controller.details('  ', undefined, REQ_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'place_id_required' } },
    });
  });
});

describe('AddressLookupController — happy path (pinned mock provider)', () => {
  beforeEach(() => {
    process.env['ADDRESS_AUTOCOMPLETE_ENABLED'] = 'true';
    process.env['ADDRESS_AUTOCOMPLETE_PROVIDER'] = 'mock';
  });
  afterEach(() => {
    delete process.env['ADDRESS_AUTOCOMPLETE_ENABLED'];
    delete process.env['ADDRESS_AUTOCOMPLETE_PROVIDER'];
  });

  it('returns suggestions for a valid query', async () => {
    const controller = new AddressLookupController(new AddressLookupService());
    const out = await controller.autocomplete('1600 mountain view', undefined, REQ_ID);
    expect(out.suggestions.length).toBeGreaterThan(0);
    const first: AddressSuggestionDto = out.suggestions[0];
    expect(first.place_id).toBe('mock-place-googleplex');
  });

  it('resolves details for a place_id', async () => {
    const controller = new AddressLookupController(new AddressLookupService());
    const out = await controller.details('mock-place-googleplex', undefined, REQ_ID);
    const details = out.details as AddressDetailsDto;
    expect(details.city).toBe('Mountain View');
    expect(details.country).toBe('US');
  });
});

describe('AddressLookupController — NEVER-BLOCK (provider failure → empty 200)', () => {
  it('autocomplete returns empty suggestions instead of a 5xx', async () => {
    const controller = new AddressLookupController(throwingService());
    const out = await controller.autocomplete('valid query here', undefined, REQ_ID);
    expect(out).toEqual({ suggestions: [] });
  });

  it('details returns null instead of a 5xx', async () => {
    const controller = new AddressLookupController(throwingService());
    const out = await controller.details('some-place-id', undefined, REQ_ID);
    expect(out).toEqual({ details: null });
  });
});

describe('AddressLookupController — session token (v1.1)', () => {
  function capturingService(captured: {
    auto?: string | undefined;
    details?: string | undefined;
  }): AddressLookupService {
    return {
      isEnabled: () => true,
      autocomplete: async (_q: string, token?: string) => {
        captured.auto = token;
        return [];
      },
      details: async (_id: string, token?: string) => {
        captured.details = token;
        return null;
      },
    } as unknown as AddressLookupService;
  }

  it('threads a present session_token to the service on BOTH routes', async () => {
    const captured: { auto?: string; details?: string } = {};
    const controller = new AddressLookupController(capturingService(captured));
    await controller.autocomplete('1600 amphitheatre', 'tok-123', REQ_ID);
    await controller.details('place-1', 'tok-123', REQ_ID);
    expect(captured.auto).toBe('tok-123');
    expect(captured.details).toBe('tok-123');
  });

  it('treats a missing token as undefined (non-breaking)', async () => {
    const captured: { auto?: string } = {};
    const controller = new AddressLookupController(capturingService(captured));
    await controller.autocomplete('1600 amphitheatre', undefined, REQ_ID);
    expect(captured.auto).toBeUndefined();
  });

  it('rejects an over-long session_token with VALIDATION_ERROR', async () => {
    const controller = new AddressLookupController(new AddressLookupService());
    const longToken = 'a'.repeat(129);
    await expect(
      controller.autocomplete('valid query', longToken, REQ_ID),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'session_token_too_long' } },
    });
  });
});

describe('AddressLookupController — guard chain (gate 5: tenant/scope/site)', () => {
  it('class carries @RequireCapability("ats")', () => {
    const caps = Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, AddressLookupController);
    expect(caps).toEqual(['ats']);
  });

  // WL-B2 (R6/R14/R17) — the ONLY guard that changed is @RequireScopes: both
  // routes now require the DEDICATED address:lookup scope (repointed off
  // company:create). @RequireSiteMatch + @RequireCapability('ats') + the class
  // JwtAuthGuard/EntitlementGuard/RolesGuard chain are preserved (R17).
  it('both routes require the DEDICATED address:lookup scope + site match', () => {
    for (const handler of [
      AddressLookupController.prototype.autocomplete,
      AddressLookupController.prototype.details,
    ]) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler)).toEqual(['address:lookup']);
      expect(Reflect.getMetadata(REQUIRES_SITE_MATCH_KEY, handler)).toBe(true);
    }
  });

  it('neither route still requires company:create (the repoint actually happened)', () => {
    for (const handler of [
      AddressLookupController.prototype.autocomplete,
      AddressLookupController.prototype.details,
    ]) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler)).not.toContain('company:create');
    }
  });
});

// WL-B2 (R6/R14) — ENFORCEMENT proofs. RolesGuard is the AuthZ checkpoint that
// reads @RequireScopes and requires AuthContext.scopes ⊇ required. We drive the
// REAL guard against the REAL handler metadata to prove the repoint's runtime
// effect end-to-end (not just the decorator value).
describe('AddressLookupController — address:lookup authorization (RolesGuard enforcement)', () => {
  const guard = new RolesGuard(new Reflector());

  // A minimal ExecutionContext exposing the real handler/class (so the real
  // Reflector reads real @RequireScopes/@RequireSiteMatch) + a principal with
  // the given scopes. Empty params/query → no requested site → site check is a
  // no-op (a tenant-wide principal), isolating the SCOPE axis.
  function ctxFor(
    handler: (...args: unknown[]) => unknown,
    cls: new (...args: never[]) => unknown,
    scopes: string[],
  ): ExecutionContext {
    const request = {
      authContext: {
        sub: '01900000-0000-7000-8000-000000000002',
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: '01900000-0000-7000-8000-000000000001',
        scopes,
        iat: 0,
        exp: 0,
      },
      requestId: REQ_ID,
      params: {},
      query: {},
    };
    return {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  // (a) a caller holding address:lookup is admitted on BOTH routes.
  it('admits a caller WITH address:lookup on autocomplete + details', () => {
    for (const handler of [
      AddressLookupController.prototype.autocomplete,
      AddressLookupController.prototype.details,
    ]) {
      const ctx = ctxFor(
        handler as (...a: unknown[]) => unknown,
        AddressLookupController,
        ['address:lookup'],
      );
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });

  // (b) a caller WITHOUT address:lookup is denied — including one that holds
  // ONLY the OLD company:create scope (proves company:create alone no longer
  // opens the lookup after the repoint).
  it('denies a caller WITHOUT address:lookup (INSUFFICIENT_PERMISSIONS, missing address:lookup)', () => {
    const ctx = ctxFor(
      AddressLookupController.prototype.autocomplete as (...a: unknown[]) => unknown,
      AddressLookupController,
      ['company:create', 'company:edit'],
    );
    try {
      guard.canActivate(ctx);
      throw new Error('expected RolesGuard to deny');
    } catch (err) {
      expect(err).toBeInstanceOf(AramoError);
      expect((err as AramoError).code).toBe('INSUFFICIENT_PERMISSIONS');
      expect((err as { context?: { details?: { missing_scopes?: string[] } } }).context?.details?.missing_scopes)
        .toContain('address:lookup');
    }
  });

  // (c1) address:lookup alone does NOT authorize a Company mutation: the Company
  // mutation controller still requires company:create, and address:lookup does
  // not satisfy it.
  it('company:create is still required by the Company mutation controller (unchanged)', () => {
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, CompanyController.prototype.create)).toEqual([
      'company:create',
    ]);
  });

  it('a principal holding ONLY address:lookup is denied a Company mutation (create)', () => {
    const ctx = ctxFor(
      CompanyController.prototype.create as (...a: unknown[]) => unknown,
      CompanyController,
      ['address:lookup'],
    );
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
  });

  // (c2) address:lookup alone does NOT authorize a Requisition mutation. The
  // requisition controller lives in libs/requisition (its own spec pins that
  // create requires requisition:create); here we prove RolesGuard does not let
  // address:lookup SATISFY a requisition:create gate.
  it('a principal holding ONLY address:lookup does NOT satisfy a requisition:create gate', () => {
    const reqCreateHandler = ((): unknown => undefined) as (...a: unknown[]) => unknown;
    Reflect.defineMetadata(REQUIRED_SCOPES_KEY, ['requisition:create'], reqCreateHandler);
    class RequisitionMutationRoute {}
    const ctx = ctxFor(reqCreateHandler, RequisitionMutationRoute, ['address:lookup']);
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
  });
});
