import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AramoError } from '@aramo/common';
import { REQUIRED_SCOPES_KEY, REQUIRES_SITE_MATCH_KEY } from '@aramo/authorization';
import { REQUIRED_CAPABILITIES_KEY } from '@aramo/entitlement';

import { AddressLookupController } from '../lib/address-lookup.controller.js';
import { AddressLookupService } from '../lib/address-lookup.service.js';
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
    await expect(controller.autocomplete('ab', REQ_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
  });

  it('rejects a blank/missing query with VALIDATION_ERROR', async () => {
    await expect(controller.autocomplete(undefined, REQ_ID)).rejects.toBeInstanceOf(AramoError);
    await expect(controller.autocomplete('   ', REQ_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects an over-long query', async () => {
    const long = 'a'.repeat(201);
    await expect(controller.autocomplete(long, REQ_ID)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'query_too_long' } },
    });
  });

  it('rejects a blank place_id on /details', async () => {
    await expect(controller.details('  ', REQ_ID)).rejects.toMatchObject({
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
    const out = await controller.autocomplete('1600 mountain view', REQ_ID);
    expect(out.suggestions.length).toBeGreaterThan(0);
    const first: AddressSuggestionDto = out.suggestions[0];
    expect(first.place_id).toBe('mock-place-googleplex');
  });

  it('resolves details for a place_id', async () => {
    const controller = new AddressLookupController(new AddressLookupService());
    const out = await controller.details('mock-place-googleplex', REQ_ID);
    const details = out.details as AddressDetailsDto;
    expect(details.city).toBe('Mountain View');
    expect(details.country).toBe('US');
  });
});

describe('AddressLookupController — NEVER-BLOCK (provider failure → empty 200)', () => {
  it('autocomplete returns empty suggestions instead of a 5xx', async () => {
    const controller = new AddressLookupController(throwingService());
    const out = await controller.autocomplete('valid query here', REQ_ID);
    expect(out).toEqual({ suggestions: [] });
  });

  it('details returns null instead of a 5xx', async () => {
    const controller = new AddressLookupController(throwingService());
    const out = await controller.details('some-place-id', REQ_ID);
    expect(out).toEqual({ details: null });
  });
});

describe('AddressLookupController — guard chain (gate 5: tenant/scope/site)', () => {
  it('class carries @RequireCapability("ats")', () => {
    const caps = Reflect.getMetadata(REQUIRED_CAPABILITIES_KEY, AddressLookupController);
    expect(caps).toEqual(['ats']);
  });

  it('both routes require company:create (NO new scope) + site match', () => {
    for (const handler of [
      AddressLookupController.prototype.autocomplete,
      AddressLookupController.prototype.details,
    ]) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, handler)).toEqual(['company:create']);
      expect(Reflect.getMetadata(REQUIRES_SITE_MATCH_KEY, handler)).toBe(true);
    }
  });
});
