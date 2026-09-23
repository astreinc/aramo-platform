import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { DocumentsRepository } from './documents.repository.js';
import { DocumentIdempotencyService } from './idempotency.service.js';
import {
  DocumentIdempotencyConflictError,
  DocumentIllegalTransitionError,
  DocumentNotFoundError,
} from './domain/errors.js';

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
const EXECUTION_MODES = new Set(['NO_SIGNATURE', 'ACKNOWLEDGEMENT', 'SINGLE_SIGNATURE', 'MULTI_SIGNATURE']);
const SOURCE_KINDS = new Set(['TEMPLATE_GENERATED', 'UPLOADED', 'EXTERNAL_IMPORT']);
const TYPE_SCOPES = new Set(['SYSTEM', 'TENANT', 'CLIENT']);

// Maps lib-local domain errors to registered AramoError codes. Keeps the
// domain layer HTTP-agnostic while the HTTP boundary owns status translation.
function toHttp(e: unknown, requestId: string): AramoError {
  if (e instanceof DocumentNotFoundError) {
    return new AramoError('DOCUMENT_NOT_FOUND', e.message, 404, { requestId });
  }
  if (e instanceof DocumentIllegalTransitionError) {
    return new AramoError('DOCUMENT_ILLEGAL_TRANSITION', e.message, 409, { requestId });
  }
  if (e instanceof DocumentIdempotencyConflictError) {
    return new AramoError('IDEMPOTENCY_KEY_CONFLICT', e.message, 409, { requestId });
  }
  return e instanceof AramoError
    ? e
    : new AramoError('INTERNAL_ERROR', e instanceof Error ? e.message : String(e), 500, { requestId });
}

function validate(condition: boolean, message: string, requestId: string): void {
  if (!condition) throw new AramoError('VALIDATION_ERROR', message, 400, { requestId });
}

interface CreateDocumentTypeBody {
  key: string;
  name: string;
  description?: string;
  scope: string;
  execution_mode_default: string;
  retention_class: string;
}

interface AssociationBody {
  resource_type: string;
  resource_id: string;
  relationship: string;
}

interface CreateDocumentBody {
  document_type_id: string;
  title: string;
  execution_mode: string;
  source_kind: string;
  associations?: AssociationBody[];
}

@Controller('v1/document-types')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentTypesController {
  constructor(private readonly repo: DocumentsRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document:manage')
  async create(
    @AuthContext() auth: AuthContextType,
    @Body() body: CreateDocumentTypeBody,
    @RequestId() requestId: string,
  ) {
    validate(typeof body?.key === 'string' && body.key.length > 0, 'key is required', requestId);
    validate(typeof body?.name === 'string' && body.name.length > 0, 'name is required', requestId);
    validate(TYPE_SCOPES.has(body.scope), 'invalid scope', requestId);
    validate(EXECUTION_MODES.has(body.execution_mode_default), 'invalid execution_mode_default', requestId);
    validate(typeof body?.retention_class === 'string' && body.retention_class.length > 0, 'retention_class is required', requestId);
    try {
      return await this.repo.createDocumentType({ tenant_id: auth.tenant_id, ...body });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async list(@AuthContext() auth: AuthContextType) {
    return this.repo.listDocumentTypes(auth.tenant_id);
  }
}

@Controller('v1/documents')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DocumentsController {
  constructor(private readonly repo: DocumentsRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document:create')
  async create(
    @AuthContext() auth: AuthContextType,
    @Body() body: CreateDocumentBody,
    @RequestId() requestId: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    validate(typeof body?.document_type_id === 'string', 'document_type_id is required', requestId);
    validate(typeof body?.title === 'string' && body.title.length > 0, 'title is required', requestId);
    validate(EXECUTION_MODES.has(body.execution_mode), 'invalid execution_mode', requestId);
    validate(SOURCE_KINDS.has(body.source_kind), 'invalid source_kind', requestId);
    for (const a of body.associations ?? []) {
      validate(RESOURCE_TYPES.has(a.resource_type), `invalid resource_type ${a.resource_type}`, requestId);
      validate(RELATIONSHIPS.has(a.relationship), `invalid relationship ${a.relationship}`, requestId);
    }
    const idem =
      idempotencyKey !== undefined && idempotencyKey.length > 0
        ? { key: idempotencyKey, request_hash: DocumentIdempotencyService.hashRequest(body) }
        : undefined;
    try {
      return await this.repo.createDocument(
        {
          tenant_id: auth.tenant_id,
          document_type_id: body.document_type_id,
          title: body.title,
          execution_mode: body.execution_mode,
          source_kind: body.source_kind,
          created_by: auth.sub,
          associations: body.associations,
          request_id: requestId,
        },
        idem,
      );
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async list(@AuthContext() auth: AuthContextType) {
    return this.repo.listDocuments(auth.tenant_id);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async get(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.getDocument(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/prepare')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:create')
  async prepare(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.prepareDocument({ tenant_id: auth.tenant_id, document_id: id, actor_id: auth.sub, request_id: requestId });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Post(':id/associations')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('document:create')
  async addAssociation(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: AssociationBody,
    @RequestId() requestId: string,
  ) {
    validate(RESOURCE_TYPES.has(body?.resource_type), `invalid resource_type ${body?.resource_type}`, requestId);
    validate(RELATIONSHIPS.has(body?.relationship), `invalid relationship ${body?.relationship}`, requestId);
    validate(typeof body?.resource_id === 'string', 'resource_id is required', requestId);
    try {
      return await this.repo.addAssociation({
        tenant_id: auth.tenant_id,
        document_id: id,
        resource_type: body.resource_type,
        resource_id: body.resource_id,
        relationship: body.relationship,
        created_by: auth.sub,
      });
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get(':id/events')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async events(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.listEvents(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }

  @Get(':id/artifacts')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('document:read')
  async artifacts(@AuthContext() auth: AuthContextType, @Param('id') id: string, @RequestId() requestId: string) {
    try {
      return await this.repo.listArtifacts(auth.tenant_id, id);
    } catch (e) {
      throw toHttp(e, requestId);
    }
  }
}
