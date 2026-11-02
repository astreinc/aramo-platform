import { Global, Module } from '@nestjs/common';
import { ACTIVITY_CONTACT_SUBJECT } from '@aramo/activity';
import { ContactModule } from '@aramo/contact';

import { ContactActivitySubjectAdapter } from './contact-activity-subject.adapter.js';

// CONTACTS-1 §8 — binds the activity lib's ACTIVITY_CONTACT_SUBJECT port to the
// ContactRepository-backed adapter. @Global so the ActivityController (declared
// in the activity lib module) resolves the token without the lib importing
// @aramo/contact.
@Global()
@Module({
  imports: [ContactModule],
  providers: [
    ContactActivitySubjectAdapter,
    { provide: ACTIVITY_CONTACT_SUBJECT, useExisting: ContactActivitySubjectAdapter },
  ],
  exports: [ACTIVITY_CONTACT_SUBJECT],
})
export class ContactActivitySubjectModule {}
