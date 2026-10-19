import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import type { LegalDocumentVersion } from './legal-documents.js';

// Commercial Plans Amendment A1 §3 — acceptance evidence for signup (checkout
// writes its own inside the checkout transaction). Records the exact document
// version and text hash; idempotent per (document, version, context, context_ref).
@Injectable()
export class LegalAcceptanceService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: {
    document: LegalDocumentVersion;
    context: 'SIGNUP' | 'CHECKOUT';
    context_ref: string;
    tenant_id: string | null;
    user_id: string | null;
    subject_email: string | null;
    accepted_at: Date;
  }): Promise<void> {
    const existing = await this.prisma.legalAcceptance.findFirst({
      where: { document_key: input.document.key, version: input.document.version, context: input.context, context_ref: input.context_ref },
    });
    if (existing !== null) return;
    await this.prisma.legalAcceptance.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        subject_email: input.subject_email,
        document_key: input.document.key,
        version: input.document.version,
        sha256: input.document.sha256,
        context: input.context,
        context_ref: input.context_ref,
        accepted_at: input.accepted_at,
      },
    });
  }
}
