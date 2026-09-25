import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TemplatesRepository } from './templates.repository.js';
import { RequirementsRepository } from './requirements.repository.js';
import {
  DocumentNotFoundError,
  DocumentRequirementAlreadySatisfiedError,
  DocumentRequirementNotFoundError,
  TemplateImmutableError,
  TemplateNotFoundError,
  TemplateVersionNotActiveError,
  TemplateVersionNotFoundError,
} from './domain/errors.js';

const TEMPLATE_KINDS = new Set(['GENERATED', 'UPLOADED_PDF', 'HYBRID']);
const FIELD_TYPES = new Set([
  'TEXT',
  'MULTILINE_TEXT',
  'DATE',
  'NUMBER',
  'CURRENCY',
  'CHECKBOX',
  'IMAGE',
  'SIGNATURE',
  'INITIALS',
  'SIGN_DATE',
  'SIGNER_NAME',
  'SIGNER_EMAIL',
]);
const RESOURCE_TYPES = new Set([
  'TALENT',
  'REQUISITION',
  'COMPANY',
  'SUBMITTAL',
  'OFFER',
  'PLACEMENT',
  'PURCHASE_ORDER',
  'TENANT_ORGANIZATION',
  'CONTACT',
]);
const RELATIONSHIPS = new Set(['SUBJECT', 'REGARDING', 'CLIENT', 'SUPPORTS', 'OWNER', 'ISSUER', 'COUNTERPARTY']);

function toHttp(e: unknown, requestId: string): AramoError {
  if (e instanceof TemplateNotFoundError) return new AramoError('TEMPLATE_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof TemplateVersionNotFoundError) return new AramoError('TEMPLATE_VERSION_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof TemplateVersionNotActiveError) return new AramoError('TEMPLATE_VERSION_NOT_ACTIVE', e.message, 409, { requestId });
  if (e instanceof TemplateImmutableError) return new AramoError('TEMPLATE_IMMUTABLE', e.message, 409, { requestId });
  if (e instanceof DocumentRequirementNotFoundError) return new AramoError('DOCUMENT_REQUIREMENT_NOT_FOUND', e.message, 404, { requestId });
  if (e instanceof DocumentRequirementAlreadySatisfiedError) return new AramoError('DOCUMENT_REQUIREMENT_ALREADY_SATISFIED', e.message, 409, { requestId });
  if (e instanceof DocumentNotFoundError) return new AramoError('DOCUMENT_NOT_FOUND', e.message, 404, { requestId });
  return e instanceof AramoError
    ? e
    : new AramoError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), 500, { requestId });
}

function validate(condition: boolean, message: string, requestId: string): void {
  if (!condition) throw new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

interface CreateTemplateBody {
  document_type_id: string;
  name: string;
  description?: string;
  template_kind: string;
  client_id?: string;
}

interface CreateVersionBody {
  render_schema_version: string;
  field_schema?: unknown;
  binding_schema?: unknown;
  source_artifact_id?: string;
}

interface AddFieldBody {
  field_key: string;
  field_type: string;
  binding_key?: string;
  required?: boolean;
  page_number?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  format_rule?: string;
  signer_role?: string;
  ordinal: number;
}

@Controller('v1/document-templates')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentTemplatesController {
  constructor(private readonly repo: TemplatesRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:manage')
  async create(@AuthContext() auth: AuthContextType, @Body() body: CreateTemplateBody, @RequestId() requestId: string) {
    validate(typeof body?.document_type_id === 'string', 'document_type_id is required', requestId);
    validate(typeof body?.name === 'string' && body.name.length > 0, 'name is required', requestId);
    validate(TEMPLATE_KINDS.has(body.template_kind), 'invalid template_kind', requestId);
    try {
      return await this.repo.createTemplate({ tenant_id: auth.tenant_id, created_by: auth.sub, ...body });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async list(@AuthContext() auth: AuthContextType) {
    return this.repo.listTemplates(auth.tenant_id);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async get(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.getTemplate(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:manage')
  async createVersion(
    @AuthContext() auth: AuthContextType,
    @Param('id') templateId: string,
    @Body() body: CreateVersionBody,
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.render_schema_version === 'string' && body.render_schema_version.length > 0, 'render_schema_version is required', requestId);
    try {
      return await this.repo.createVersion({
        tenant_id: auth.tenant_id,
        template_id: templateId,
        render_schema_version: body.render_schema_version,
        field_schema: body.field_schema,
        binding_schema: body.binding_schema,
        source_artifact_id: body.source_artifact_id,
        created_by: auth.sub,
      });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get(':id/versions')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async listVersions(@AuthContext() auth: AuthContextType, @Param('id') templateId: string, @RequestId() requestId: string) {
    try {
      return await this.repo.listVersions(auth.tenant_id, templateId);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:manage')
  async activate(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string) {
    try {
      return await this.repo.activateVersion({ tenant_id: auth.tenant_id, version_id: versionId, actor_id: auth.sub });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post('versions/:versionId/fields')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_template:manage')
  async addField(
    @AuthContext() auth: AuthContextType,
    @Param('versionId') versionId: string,
    @Body() body: AddFieldBody,
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.field_key === 'string' && body.field_key.length > 0, 'field_key is required', requestId);
    validate(FIELD_TYPES.has(body.field_type), 'invalid field_type', requestId);
    validate(typeof body?.ordinal === 'number', 'ordinal is required', requestId);
    try {
      return await this.repo.addField({ tenant_id: auth.tenant_id, template_version_id: versionId, ...body });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get('versions/:versionId/fields')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_template:read')
  async listFields(@AuthContext() auth: AuthContextType, @Param('versionId') versionId: string, @RequestId() requestId: string) {
    try {
      return await this.repo.listFields(auth.tenant_id, versionId);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}

interface CreateRequirementBody {
  document_type_id: string;
  resource_type: string;
  resource_id: string;
  relationship?: string;
}

@Controller('v1/document-requirements')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentRequirementsController {
  constructor(private readonly repo: RequirementsRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document_requirement:manage')
  async create(@AuthContext() auth: AuthContextType, @Body() body: CreateRequirementBody, @RequestId() requestId: string) {
    validate(typeof body?.document_type_id === 'string', 'document_type_id is required', requestId);
    validate(RESOURCE_TYPES.has(body?.resource_type), `invalid resource_type ${body?.resource_type}`, requestId);
    validate(typeof body?.resource_id === 'string', 'resource_id is required', requestId);
    if (body.relationship !== undefined) {
      validate(RELATIONSHIPS.has(body.relationship), `invalid relationship ${body.relationship}`, requestId);
    }
    try {
      return await this.repo.createRequirement({ tenant_id: auth.tenant_id, created_by: auth.sub, ...body });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:read')
  async list(
    @AuthContext() auth: AuthContextType,
    @Query('resource_type') resourceType?: string,
    @Query('resource_id') resourceId?: string,
  ) {
    return this.repo.listRequirements(auth.tenant_id, { resource_type: resourceType, resource_id: resourceId });
  }

  @Get(':id/check')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:read')
  async check(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.checkRequirement(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/satisfy')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:manage')
  async satisfy(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: { document_id: string },
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.document_id === 'string', 'document_id is required', requestId);
    try {
      return await this.repo.satisfyRequirement({ tenant_id: auth.tenant_id, id, document_id: body.document_id, actor_id: auth.sub });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/waive')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document_requirement:manage')
  async waive(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: { reason: string },
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.reason === 'string' && body.reason.length > 0, 'reason is required', requestId);
    try {
      return await this.repo.waiveRequirement({ tenant_id: auth.tenant_id, id, reason: body.reason, actor_id: auth.sub });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}

interface CreatePacketBody {
  packet_type: string;
  title: string;
}

interface AddPacketItemBody {
  document_id: string;
  sequence: number;
  required?: boolean;
}

@Controller('v1/document-packets')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentPacketsController {
  constructor(private readonly repo: TemplatesRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document:create')
  async create(@AuthContext() auth: AuthContextType, @Body() body: CreatePacketBody, @RequestId() requestId: string) {
    validate(typeof body?.packet_type === 'string' && body.packet_type.length > 0, 'packet_type is required', requestId);
    validate(typeof body?.title === 'string' && body.title.length > 0, 'title is required', requestId);
    return this.repo.createPacket({ tenant_id: auth.tenant_id, created_by: auth.sub, ...body });
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async list(@AuthContext() auth: AuthContextType) {
    return this.repo.listPackets(auth.tenant_id);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async get(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.getPacket(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/items')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document:create')
  async addItem(
    @AuthContext() auth: AuthContextType,
    @Param('id') packetId: string,
    @Body() body: AddPacketItemBody,
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.document_id === 'string', 'document_id is required', requestId);
    validate(typeof body?.sequence === 'number', 'sequence is required', requestId);
    try {
      return await this.repo.addPacketItem({
        tenant_id: auth.tenant_id,
        packet_id: packetId,
        document_id: body.document_id,
        sequence: body.sequence,
        required: body.required,
      });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}
