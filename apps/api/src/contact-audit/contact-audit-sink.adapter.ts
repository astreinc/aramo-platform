import { Injectable } from '@nestjs/common';
import type { ContactAuditSink } from '@aramo/contact';
import { IdentityAuditService } from '@aramo/identity';

// CONTACTS-1 §5 SD-11 — the CONTACT_AUDIT_SINK adapter: contact soft delete /
// restore land in the identity audit ledger (identity.contact.deleted /
// identity.contact.restored). IdentityAuditService.writeEvent is best-effort
// (it swallows and logs ledger errors), so an audit failure never blocks the
// delete or restore that already committed. Payload carries no name, email or
// phone — the company id only.
@Injectable()
export class IdentityContactAuditSink implements ContactAuditSink {
  constructor(private readonly audit: IdentityAuditService) {}

  async record(args: {
    event: 'deleted' | 'restored';
    tenant_id: string;
    actor_id: string;
    contact_id: string;
    company_id: string;
  }): Promise<void> {
    await this.audit.writeEvent({
      event_type:
        args.event === 'deleted' ? 'identity.contact.deleted' : 'identity.contact.restored',
      actor_type: 'user',
      actor_id: args.actor_id,
      tenant_id: args.tenant_id,
      subject_id: args.contact_id,
      payload: { company_id: args.company_id },
    });
  }
}
