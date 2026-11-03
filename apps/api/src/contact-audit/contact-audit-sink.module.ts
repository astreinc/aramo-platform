import { Global, Module } from '@nestjs/common';
import { CONTACT_AUDIT_SINK } from '@aramo/contact';
import { IdentityCoreModule } from '@aramo/identity';

import { IdentityContactAuditSink } from './contact-audit-sink.adapter.js';

// CONTACTS-1 SD-11 — binds libs/contact's CONTACT_AUDIT_SINK port to the
// identity audit ledger. @Global so ContactRepository (declared in the contact
// lib module) resolves the token without the lib importing identity.
@Global()
@Module({
  imports: [IdentityCoreModule],
  providers: [
    IdentityContactAuditSink,
    { provide: CONTACT_AUDIT_SINK, useExisting: IdentityContactAuditSink },
  ],
  exports: [CONTACT_AUDIT_SINK],
})
export class ContactAuditSinkModule {}
