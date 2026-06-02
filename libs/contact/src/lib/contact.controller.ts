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
  UseGuards,
} from '@nestjs/common';
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
import { ContactRepository } from './contact.repository.js';

// ContactController — PR-A2 Gate 5 ATS Batch 1. Mirrors CompanyController
// guard chain + decorator placement verbatim (the pattern — Ruling 6).
@Controller('v1/contacts')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ContactController {
  constructor(private readonly contactRepository: ContactRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('contact:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('company_id') companyId: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
  ): Promise<{ items: ContactView[] }> {
    const items = await this.contactRepository.list({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
      site_id: siteIdFromQuery,
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
  ): Promise<ContactView> {
    const view = await this.contactRepository.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Contact not found in tenant',
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
