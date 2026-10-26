import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, PLATFORM_TENANT_SENTINEL_ID, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  COMMERCIAL_AUDIT_EXPORT_MAX_ROWS,
  CommercialAuditExportService,
  CommercialAuditExportTooLargeError,
  CommercialOperatorRosterService,
  CommercialPolicyGovernanceService,
  type CommercialActor,
  type CommercialCallContext,
  type CommercialPolicyVersionRow,
  type PolicyVersionView,
} from '@aramo/subscription';

import type { CommercialAuditExportResponseDto, CommercialPolicyContentDto, CommercialPolicyListDto, CommercialPolicyVersionDto, CommercialRosterDto } from './dto/commercial-governance.dto.js';
import { CommercialAuditExportDto, CreatePolicyDraftDto, UpdatePolicyDraftDto } from './dto/commercial-governance.dto.js';
import { toAramoError } from './platform-commercial-change-request.controller.js';

// CCP-B5 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B5; B5-P; handoff §5.6,
// §5.8) — the commercial policy screen and the Platform admins › commercial roles read.
// Platform consumer only (the DDR §13.1 tripwire).
//
// Route gate `platform:approval:read`, held by all 6 CCP roles and never by super_admin
// (CCP A1 §4.1; INV-1, PBD §12). Below the gate:
//   GET   policy-versions        every CCP role (read)
//   POST  policy-versions        a DRAFT from a version — the live platform_owner or
//   PATCH policy-versions/:id    finance_admin role (TD-A3-5 precedent: no governance scope)
//   GET   operators              the live roster + chain fulfillability (read-only)
// and, under `platform:commercial:audit:read` (platform_owner, finance_admin,
// read_only_auditor — the A2 audit-read scope):
//   POST  audit-events/export    the READ-ONLY CSV export of the filtered audit stream; it
//                                appends exactly one COMMERCIAL_AUDIT_EXPORTED event and
//                                writes nothing else (handoff §5.7 "the export is itself an
//                                audit event"; pre-execution C-5)
// ACTIVATING a version is not a route here: it is a POLICY_ACTIVATE change request on
// POST /platform/commercial/change-requests (requested by finance_admin, chain finance →
// owner), applied after the chain completes (TD-A9-16). Role changes are ROLE_GRANT /
// ROLE_REVOKE change requests on the same route; nothing here grants a role.

@Controller('platform/commercial')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialGovernanceController {
  constructor(
    private readonly policies: CommercialPolicyGovernanceService,
    private readonly roster: CommercialOperatorRosterService,
    private readonly exporter: CommercialAuditExportService,
  ) {}

  @Get('policy-versions')
  @RequireScopes('platform:approval:read')
  async listPolicyVersions(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<CommercialPolicyListDto> {
    platformOnly(auth, requestId);
    const v = await run(requestId, () => this.policies.list(actorOf(auth), ctxOf(requestId)));
    return { versions: v.versions.map(versionDto), active_version_id: v.active_version_id, open_request: v.open_request, caller: v.caller };
  }

  @Post('policy-versions')
  @HttpCode(201)
  @RequireScopes('platform:approval:read')
  async createPolicyDraft(@Body() body: CreatePolicyDraftDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ version: CommercialPolicyVersionDto }> {
    platformOnly(auth, requestId);
    const row = await run(requestId, () => this.policies.createDraft(actorOf(auth), { source_version_id: body.source_version_id, note: body.note ?? null }, ctxOf(requestId)));
    return { version: versionDto({ row, content: row.content, open_request: null, latest_request: null }) };
  }

  @Patch('policy-versions/:id')
  @RequireScopes('platform:approval:read')
  async updatePolicyDraft(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePolicyDraftDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ version: CommercialPolicyVersionDto }> {
    platformOnly(auth, requestId);
    const row = await run(requestId, () =>
      this.policies.updateDraft(actorOf(auth), id, { ...(body.content === undefined ? {} : { content: definedOnly(body.content) }), ...(body.note === undefined ? {} : { note: body.note }) }, ctxOf(requestId)),
    );
    return { version: versionDto({ row, content: row.content, open_request: null, latest_request: null }) };
  }

  @Post('audit-events/export')
  @HttpCode(200)
  @RequireScopes('platform:commercial:audit:read')
  async exportAudit(@Body() body: CommercialAuditExportDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<CommercialAuditExportResponseDto> {
    platformOnly(auth, requestId);
    const from = body.from === undefined ? undefined : new Date(body.from);
    const to = body.to === undefined ? undefined : new Date(body.to);
    if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
      throw new AramoError('VALIDATION_ERROR', '`from` must be earlier than `to`', 400, { requestId, details: { reason: 'invalid_date_range' } });
    }
    const out = await run(requestId, async () => {
      try {
        return await this.exporter.export(
          actorOf(auth),
          {
            actor_id: body.actor_id,
            event_type: body.event_type,
            tenant_id: body.tenant_id,
            from,
            to,
            exception_only: body.exception_only === true,
            change_request_id: body.change_request_id,
            product_key: body.product_key,
          },
          ctxOf(requestId),
        );
      } catch (err) {
        if (err instanceof CommercialAuditExportTooLargeError) {
          throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'export_too_large', max_rows: COMMERCIAL_AUDIT_EXPORT_MAX_ROWS } });
        }
        throw err;
      }
    });
    return { export_id: out.export_id, exported_at: out.exported_at.toISOString(), row_count: out.row_count, filename: out.filename, content_type: 'text/csv', csv: out.csv, csv_sha256: out.csv_sha256 };
  }

  @Get('operators')
  @RequireScopes('platform:approval:read')
  async listOperators(@AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<CommercialRosterDto> {
    platformOnly(auth, requestId);
    return run(requestId, () => this.roster.read(PLATFORM_TENANT_SENTINEL_ID));
  }
}

function platformOnly(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

async function run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toAramoError(err, requestId);
  }
}

function actorOf(auth: AuthContextType): CommercialActor {
  return { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes };
}

function ctxOf(requestId: string): CommercialCallContext {
  return { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId };
}

/** The keys actually sent (a transformed DTO instance can carry every declared key as undefined). */
function definedOnly(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function versionDto(v: Pick<PolicyVersionView, 'open_request' | 'latest_request'> & { row: CommercialPolicyVersionRow; content: unknown }): CommercialPolicyVersionDto {
  const r = v.row;
  return {
    id: r.id,
    version_number: r.version_number,
    status: r.status,
    content: (v.content ?? null) as CommercialPolicyContentDto | null,
    content_checksum: r.content_checksum,
    note: r.note,
    created_by: r.created_by,
    created_at: r.created_at.toISOString(),
    activated_by: r.activated_by,
    activated_at: iso(r.activated_at),
    retired_at: iso(r.retired_at),
    open_request: v.open_request,
    latest_request: v.latest_request === null ? null : { id: v.latest_request.id, state: v.latest_request.state, applied_at: iso(v.latest_request.applied_at) },
  };
}
