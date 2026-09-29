import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import {
  CreateEmailTemplateRequestDto,
  PreviewEmailTemplateRequestDto,
  UpdateEmailTemplateRequestDto,
} from './dto/email-template.dto.js';
import {
  EmailTemplateService,
  type EmailTemplatePreview,
  type EmailTemplateView,
} from './email-template.service.js';

// D-EMAIL-TPL-1 (ET-4) — Settings → Communication → Email & notifications template
// management. Three-axis authorization (JwtAuthGuard + EntitlementGuard + RolesGuard)
// + ats capability. READ scope gates list/get/preview; MANAGE scope gates
// create/update/deactivate. tenant + actor come from the JWT, never the body. This
// surface manages tenant OVERRIDE rows only — the code-owned default is read-only.
@Controller('v1/communications/email-templates')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class EmailTemplateController {
  constructor(private readonly templates: EmailTemplateService) {}

  @Get()
  @RequireScopes('communication:template:read')
  async list(@AuthContext() auth: AuthContextType): Promise<{ items: EmailTemplateView[] }> {
    return { items: await this.templates.list(auth.tenant_id) };
  }

  @Get(':id')
  @RequireScopes('communication:template:read')
  async get(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<EmailTemplateView> {
    return this.templates.get(auth.tenant_id, id, requestId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('communication:template:manage')
  async create(
    @AuthContext() auth: AuthContextType,
    @Body() body: CreateEmailTemplateRequestDto,
    @RequestId() requestId: string,
  ): Promise<EmailTemplateView> {
    return this.templates.create(auth.tenant_id, auth.sub, body, requestId);
  }

  @Patch(':id')
  @RequireScopes('communication:template:manage')
  async update(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateEmailTemplateRequestDto,
    @RequestId() requestId: string,
  ): Promise<EmailTemplateView> {
    return this.templates.update(auth.tenant_id, auth.sub, id, body, requestId);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('communication:template:manage')
  async deactivate(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.templates.deactivate(auth.tenant_id, auth.sub, id, requestId);
  }

  // Preview renders the SUBMITTED (browser-edited) template content against a
  // server-owned SAMPLE context — validated, closed-allowlist only. The :id names
  // the template being edited; the authoritative context is never browser-supplied.
  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:template:read')
  async preview(
    @Body() body: PreviewEmailTemplateRequestDto,
    @RequestId() requestId: string,
  ): Promise<EmailTemplatePreview> {
    return this.templates.preview(body, requestId);
  }
}
