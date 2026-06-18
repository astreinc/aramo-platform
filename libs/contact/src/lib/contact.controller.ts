import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { ContactView } from './dto/contact.view.js';
import type { CreateContactRequestDto } from './dto/create-contact-request.dto.js';
import type { UpdateContactRequestDto } from './dto/update-contact-request.dto.js';
import type {
  ContactSearchPage,
  ContactSearchQuery,
  ContactSortKey,
  SortDir,
} from './dto/contact-search.dto.js';
import { ContactRepository } from './contact.repository.js';

// ContactController — PR-A2 Gate 5 ATS Batch 1. Mirrors CompanyController
// guard chain + decorator placement verbatim (the pattern — Ruling 6).
@Controller('v1/contacts')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ContactController {
  constructor(private readonly contactRepository: ContactRepository) {}

  // Search PR-1 — the LIST route gates on contact:read (route-static). The
  // optional ?q= quick-search ADDITIONALLY requires contact:search WHEN q is
  // present; the no-q LIST keeps its contact:read-only gate. The trigram
  // (first_name/last_name OR) filter ANDs with the D4b visibility predicate
  // (and any company_id narrowing) — NARROWS within the visible set.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('contact:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('company_id') companyId: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Query('q') q: string | undefined,
    @Query('paged') paged: string | undefined,
    @Query('scope') scope: string | undefined,
    @Query() qp: Record<string, string | undefined>,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<{ items: ContactView[] } | ContactSearchPage> {
    const searchTerm = q?.trim() ? q.trim() : undefined;
    if (searchTerm !== undefined && !authContext.scopes.includes('contact:search')) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'contact:search scope required for ?q= quick-search',
        403,
        { requestId, details: { reason: 'search_scope_missing', required_scope: 'contact:search' } },
      );
    }
    const visibility = await req.resolveVisibility!();

    // Contact-spec amendment v1.0 — server-side faceted page. Same route + gate
    // (contact:read; ?q= still adds contact:search above); ?paged=true switches
    // the projection. scope=mine narrows to the actor's OWN contacts via an
    // owner_id predicate derived SERVER-SIDE from the JWT — never trusted from
    // the client (the corrected pattern — NOT a client filter over an all-
    // contacts payload).
    if (paged === 'true') {
      const csv = (v: string | undefined): string[] | undefined => {
        if (v === undefined || v.trim() === '') return undefined;
        const parts = v.split(',').map((s) => s.trim()).filter((s) => s !== '');
        return parts.length > 0 ? parts : undefined;
      };
      const relationshipRole = csv(qp['relationship_role']);
      const preference = csv(qp['preference']);
      const companyIds = csv(qp['company_id']);
      const pageSize = qp['page_size'] ? Number(qp['page_size']) : undefined;
      const query: ContactSearchQuery = {
        tenant_id: authContext.tenant_id,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
        ...(searchTerm === undefined ? {} : { q: searchTerm }),
        ...(scope === 'mine' ? { owner_id: authContext.sub } : {}),
        ...(relationshipRole === undefined ? {} : { relationship_role: relationshipRole }),
        ...(preference === undefined ? {} : { preference }),
        ...(companyIds === undefined ? {} : { company_id: companyIds }),
        ...(qp['is_hot'] === 'true' ? { is_hot: true } : {}),
        ...(qp['quiet'] === 'true' ? { quiet: true } : {}),
        ...(qp['former'] === 'true' ? { former: true } : {}),
        ...(qp['cold_callable'] === 'true' ? { cold_callable: true } : {}),
        ...(qp['sort'] ? { sort: qp['sort'] as ContactSortKey } : {}),
        ...(qp['dir'] ? { dir: qp['dir'] as SortDir } : {}),
        ...(qp['cursor'] ? { cursor: qp['cursor'] } : {}),
        ...(pageSize !== undefined && Number.isFinite(pageSize)
          ? { page_size: pageSize }
          : {}),
      };
      return this.contactRepository.searchPaged(query, visibility);
    }

    const items = await this.contactRepository.listForActor({
      tenant_id: authContext.tenant_id,
      visibility,
      company_id: companyId,
      site_id: siteIdFromQuery,
      q: searchTerm,
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('contact:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ContactView> {
    const visibility = await req.resolveVisibility!();
    const view = await this.contactRepository.findByIdForActor({
      tenant_id: authContext.tenant_id,
      id,
      visibility,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Contact not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('contact:create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateContactRequestDto,
    @RequestId() requestId: string,
  ): Promise<ContactView> {
    return this.contactRepository.create({
      tenant_id: authContext.tenant_id,
      entered_by_id: authContext.sub,
      input: body,
      requestId,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('contact:edit')
  @RequireSiteMatch()
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateContactRequestDto,
    @RequestId() requestId: string,
  ): Promise<ContactView> {
    return this.contactRepository.update({
      tenant_id: authContext.tenant_id,
      id,
      input: body,
      requestId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('contact:delete')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.contactRepository.delete({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }
}
