import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { ContractRepository, withholdContractTerms, type ContractDetailView, type ContractPerson, type ContractSummaryView } from '@aramo/subscription';

import type {
  CommercialContractAmendmentDto,
  CommercialContractDetailDto,
  CommercialContractListResponseDto,
  CommercialContractPersonDto,
  CommercialContractSummaryDto,
} from './dto/commercial-contract.dto.js';
import { ListCommercialContractsQueryDto } from './dto/commercial-contract.dto.js';
import { amountAccess } from './finance-amount-access.js';

// CCP-B4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B4; MP-A2 N-3; Charter L6) —
// the READ-ONLY enterprise contract surface. Contracts are recorded, amended and ended ONLY
// through governed change requests applied by CCP-A6 (SUBSCRIPTION_OPEN / _CHANGE / _END with a
// contract block); this controller writes nothing. Not a quoting tool (CPQ is out, Charter L6).
//
// Gate `platform:subscription:read` (CCP A1 §4.1: platform_owner, finance_admin,
// commercial_ops, support_admin, read_only_auditor; NOT catalog_manager, NOT super_admin — INV-1,
// PBD §12). Platform consumer only (the DDR §13.1 tripwire).
//
// CCP-R3-W (Architect W-2, 2026-10-25): the free-text negotiated terms (`terms`, `recorded_terms`,
// every amendment's `terms`) are sent only to a caller holding platform:billing:read AND
// platform:billing:amount:read (platform_owner, finance_admin, read_only_auditor); for anyone else
// they are omitted at this projection boundary with `terms_withheld: "FINANCE_SCOPE_REQUIRED"`. The
// summary list carries no terms. The stored terms are unchanged.

@Controller('platform/commercial/contracts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialContractController {
  constructor(private readonly contracts: ContractRepository) {}

  @Get()
  @RequireScopes('platform:subscription:read')
  async list(
    @Query() query: ListCommercialContractsQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialContractListResponseDto> {
    platformOnly(auth, requestId);
    const rows = await this.contracts.list({ tenant_id: query.tenant_id, status: query.status, limit: query.limit });
    return { contracts: rows.map(summaryDto) };
  }

  @Get(':id')
  @RequireScopes('platform:subscription:read')
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialContractDetailDto> {
    platformOnly(auth, requestId);
    const c = await this.contracts.get(id);
    if (c === null) throw new AramoError('NOT_FOUND', 'Contract not found', 404, { requestId, details: { contract_id: id } });
    return detailDto(c, amountAccess(auth));
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

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const person = (p: ContractPerson): CommercialContractPersonDto => ({ user_id: p.user_id, display_name: p.display_name, email: p.email });

function summaryDto(c: ContractSummaryView): CommercialContractSummaryDto {
  return {
    id: c.id,
    contract_ref: c.contract_ref,
    tenant: c.tenant,
    product_key: c.product_key,
    status: c.status,
    subscription: {
      id: c.subscription.id,
      source: c.subscription.source,
      status: c.subscription.status,
      ended_at: iso(c.subscription.ended_at),
      commitment_start: iso(c.subscription.commitment_start),
      commitment_end: iso(c.subscription.commitment_end),
      plan: c.subscription.plan,
      plan_version: c.subscription.plan_version,
    },
    provenance: c.provenance,
    recorded_at: c.recorded_at.toISOString(),
  };
}

function detailDto(c: ContractDetailView, amount_access: boolean): CommercialContractDetailDto {
  const detail = {
    ...summaryDto(c),
    terms: c.terms,
    recorded_terms: c.recorded_terms,
    evidence_ref: c.evidence_ref,
    recorded_by: person(c.recorded_by),
    recorded_by_change_request_id: c.recorded_by_change_request_id,
    documents: c.documents.map((d) => ({
      name: d.name,
      sha256: d.sha256,
      byte_size: d.byte_size ?? null,
      media_type: d.media_type ?? null,
      recorded_by: person(d.recorded_by),
      recorded_at: d.recorded_at.toISOString(),
      amendment_sequence: d.amendment_sequence,
    })),
    amendments: c.amendments.map(
      (a) =>
        withholdContractTerms(
          {
            sequence: a.sequence,
            kind: a.kind,
            summary: a.summary,
            terms: a.terms,
            document_count: a.documents.length,
            evidence_ref: a.evidence_ref,
            change_request_id: a.change_request_id,
            recorded_by: person(a.recorded_by),
            recorded_at: a.recorded_at.toISOString(),
          },
          amount_access,
        ) as unknown as CommercialContractAmendmentDto,
    ),
    invoicing: c.invoicing,
  };
  return withholdContractTerms(detail, amount_access) as unknown as CommercialContractDetailDto;
}
