import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { JwtAuthGuard } from '@aramo/auth';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { AddressLookupService } from './address-lookup.service.js';
import type { AddressSuggestionDto } from './dto/address-suggestion.dto.js';
import type { AddressDetailsDto } from './dto/address-details.dto.js';

const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 200;
const MAX_PLACE_ID_LENGTH = 512;
// Address-Autocomplete v1.1 — a Google session token is a UUID (36 chars); cap
// generously. OPTIONAL: absent → the lookup behaves exactly as v1.0.
const MAX_SESSION_TOKEN_LENGTH = 128;

// AddressLookupController — backend proxy for provider address autocomplete
// (Address-Autocomplete v1.0).
//
// Guard chain (mirrors CompanyController exactly — company.controller.ts:
// 57-60,137-138): JwtAuthGuard → EntitlementGuard(@RequireCapability('ats'))
// → RolesGuard(@RequireScopes('company:create') + @RequireSiteMatch). NO new
// scope — the lookup folds into company:create (the surface it serves: filling
// the company create form). The full chain bounds the PAID external-API cost
// to legitimately-scoped, tenant-matched users.
//
// The provider key NEVER reaches this layer's output: the adapter sends it in
// a request header only; these routes return only mapped DTOs (directive R10).
//
// NEVER-BLOCK (directive R7): a provider throw/timeout is caught and translated
// to an empty-200 ({suggestions: []} / {details: null}) — never a 5xx. The FE
// then shows "no results" and the user types the address manually. Only the
// caller's own bad input (query <3 / blank place_id) is a 400.
@Controller('v1/address-lookup')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class AddressLookupController {
  private readonly logger = new Logger(AddressLookupController.name);

  constructor(private readonly addressLookup: AddressLookupService) {}

  @Get('autocomplete')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:create')
  @RequireSiteMatch()
  async autocomplete(
    @Query('query') query: string | undefined,
    @Query('session_token') sessionToken: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ suggestions: AddressSuggestionDto[] }> {
    const q = (query ?? '').trim();
    if (q.length < MIN_QUERY_LENGTH) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `query must be at least ${MIN_QUERY_LENGTH} characters`,
        400,
        { requestId, details: { reason: 'query_too_short', min_length: MIN_QUERY_LENGTH } },
      );
    }
    if (q.length > MAX_QUERY_LENGTH) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `query must be at most ${MAX_QUERY_LENGTH} characters`,
        400,
        { requestId, details: { reason: 'query_too_long', max_length: MAX_QUERY_LENGTH } },
      );
    }
    const token = this.validateSessionToken(sessionToken, requestId);
    try {
      const suggestions = await this.addressLookup.autocomplete(q, token);
      return { suggestions };
    } catch (err) {
      // NEVER-BLOCK: provider failure → empty-200. Log a short reason only —
      // never the query payload or any key material.
      this.logger.warn(
        `address autocomplete provider failed (${this.reason(err)}); returning empty result`,
      );
      return { suggestions: [] };
    }
  }

  @Get('details')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:create')
  @RequireSiteMatch()
  async details(
    @Query('place_id') placeId: string | undefined,
    @Query('session_token') sessionToken: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ details: AddressDetailsDto | null }> {
    const id = (placeId ?? '').trim();
    if (id.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'place_id is required',
        400,
        { requestId, details: { reason: 'place_id_required' } },
      );
    }
    if (id.length > MAX_PLACE_ID_LENGTH) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'place_id is too long',
        400,
        { requestId, details: { reason: 'place_id_too_long', max_length: MAX_PLACE_ID_LENGTH } },
      );
    }
    const token = this.validateSessionToken(sessionToken, requestId);
    try {
      const details = await this.addressLookup.details(id, token);
      return { details };
    } catch (err) {
      // NEVER-BLOCK: provider failure → null details (200). The FE leaves the
      // address fields for manual entry.
      this.logger.warn(
        `address details provider failed (${this.reason(err)}); returning null details`,
      );
      return { details: null };
    }
  }

  // Address-Autocomplete v1.1 — OPTIONAL session token. Absent/blank → undefined
  // (the lookup runs exactly as v1.0). Present-but-over-cap → VALIDATION_ERROR
  // (malformed caller input, consistent with the query/place_id guards). The
  // token is request-only — never logged here, never echoed in a response.
  private validateSessionToken(
    raw: string | undefined,
    requestId: string,
  ): string | undefined {
    const token = (raw ?? '').trim();
    if (token.length === 0) return undefined;
    if (token.length > MAX_SESSION_TOKEN_LENGTH) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'session_token is too long',
        400,
        { requestId, details: { reason: 'session_token_too_long', max_length: MAX_SESSION_TOKEN_LENGTH } },
      );
    }
    return token;
  }

  // Short, payload-free reason for the warn line.
  private reason(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown';
  }
}
