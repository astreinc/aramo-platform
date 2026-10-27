import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import type { SignerAttestedNamePort, SignerAttestedNameQuery } from './ports/signer-attested-name.port.js';

// M-A6 §2.2 × M-A5 §3.4 — the default SIGNER_ATTESTED_NAME_PORT binding: the name
// a HOSTED (in-person) signer confirmed when accepting the disclosure, read from
// SignerDisclosureAcceptance.attested_name for THAT session. Any other session
// origin (LINK, INBOX, SELF, legacy NULL) answers null, so SIGNER_PROFILE names
// fall back to Signer.name.
@Injectable()
export class PrismaSignerAttestedNameAdapter implements SignerAttestedNamePort {
  constructor(private readonly prisma: PrismaService) {}

  async attestedName(query: SignerAttestedNameQuery): Promise<string | null> {
    const session = await this.prisma.signingSession.findFirst({
      where: { id: query.session_id, tenant_id: query.tenant_id, envelope_id: query.envelope_id, signer_id: query.signer_id, origin: 'HOSTED' },
      select: { id: true },
    });
    if (session === null) return null;
    const acceptance = await this.prisma.signerDisclosureAcceptance.findFirst({
      where: { tenant_id: query.tenant_id, signer_id: query.signer_id, session_id: query.session_id, attested_name: { not: null } },
      orderBy: { accepted_at: 'desc' },
      select: { attested_name: true },
    });
    return acceptance?.attested_name ?? null;
  }
}
