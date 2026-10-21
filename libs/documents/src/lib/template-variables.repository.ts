import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { TemplateVariableKeyConflictError, TemplateVariableNotFoundError } from './domain/errors.js';

// DOC-TEMPLATE-LIB-1 T-2 (§2 F-7, §6.1; ADR-0034 D7) — the Aramo-maintained template
// variable catalog (documents.TemplateVariable). Platform-maintained: no tenant_id.
// Written ONLY through the platform-tier routes (apps/api, platform:document_template:
// manage); read by those routes and by the template capability port (the governed
// Insert-field catalog + closed-binding validation). The binding VALUE resolvers stay
// in apps/api — this table only says which keys exist, how they are labelled, and the
// safe sample used by previews.

// The value-carrying subset of the TemplateFieldDefinition field types (DB CHECK).
export const TEMPLATE_VARIABLE_DATA_TYPES = ['TEXT', 'MULTILINE_TEXT', 'DATE', 'NUMBER', 'CURRENCY'] as const;
export type TemplateVariableDataType = (typeof TEMPLATE_VARIABLE_DATA_TYPES)[number];

export interface TemplateVariableRow {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly group_label: string;
  readonly data_type: string;
  readonly products: string[];
  readonly ats_binding_key: string | null;
  readonly sample_value: string | null;
  readonly active: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface CreateTemplateVariableInput {
  key: string;
  label: string;
  group_label: string;
  data_type: TemplateVariableDataType;
  products: string[];
  ats_binding_key: string | null;
  sample_value: string | null;
  active: boolean;
}

// The key is immutable (it is the token stored inside template content).
export type UpdateTemplateVariableInput = Partial<Omit<CreateTemplateVariableInput, 'key'>>;

// The read seam the capability port depends on (a fake in unit tests).
export interface TemplateVariableCatalogReader {
  listActive(): Promise<readonly TemplateVariableRow[]>;
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (code === 'P2002') return true;
  const original = (e as { meta?: { driverAdapterError?: { cause?: { originalMessage?: string; kind?: string } } } })?.meta
    ?.driverAdapterError?.cause;
  return (
    (typeof original?.originalMessage === 'string' && original.originalMessage.includes('TemplateVariable_key_key')) ||
    original?.kind === 'UniqueConstraintViolation'
  );
}

@Injectable()
export class TemplateVariablesRepository implements TemplateVariableCatalogReader {
  constructor(private readonly prisma: PrismaService) {}

  async listAll(): Promise<TemplateVariableRow[]> {
    return this.prisma.templateVariable.findMany({ orderBy: [{ group_label: 'asc' }, { key: 'asc' }] });
  }

  async listActive(): Promise<TemplateVariableRow[]> {
    return this.prisma.templateVariable.findMany({ where: { active: true }, orderBy: [{ group_label: 'asc' }, { key: 'asc' }] });
  }

  async getById(id: string): Promise<TemplateVariableRow> {
    const row = await this.prisma.templateVariable.findUnique({ where: { id } });
    if (row === null) throw new TemplateVariableNotFoundError(id);
    return row;
  }

  async create(input: CreateTemplateVariableInput): Promise<TemplateVariableRow> {
    try {
      return await this.prisma.templateVariable.create({ data: { id: randomUUID(), ...input } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new TemplateVariableKeyConflictError(input.key);
      throw e;
    }
  }

  async update(id: string, patch: UpdateTemplateVariableInput): Promise<TemplateVariableRow> {
    const r = await this.prisma.templateVariable.updateMany({ where: { id }, data: { ...patch } });
    if (r.count === 0) throw new TemplateVariableNotFoundError(id);
    return this.getById(id);
  }
}
