import { Injectable } from '@nestjs/common';
import { AramoError, type VisibilityContextShape } from '@aramo/common';
import type { ActivityContactSubjectPort } from '@aramo/activity';
import { ContactRepository } from '@aramo/contact';

// CONTACTS-1 §8 (H-1..H-4) — the concrete contact-subject adapter bound to the
// activity lib's ACTIVITY_CONTACT_SUBJECT port. This is the ONLY place the
// manual activity path crosses into the contact domain; @aramo/activity stays
// free of any @aramo/contact import (no new nx edge between the libs).
@Injectable()
export class ContactActivitySubjectAdapter implements ActivityContactSubjectPort {
  constructor(private readonly contacts: ContactRepository) {}

  // Visibility first, so an invisible contact (deleted or not) answers 404
  // exactly like an invisible contact read; then the deleted check (H-4).
  async assertRecordable(args: {
    tenant_id: string;
    contact_id: string;
    visibility: VisibilityContextShape;
    requestId: string;
  }): Promise<void> {
    const visible = await this.isVisible(args);
    if (!visible) {
      throw new AramoError(
        'NOT_FOUND',
        'Contact not found in tenant (or not visible to actor)',
        404,
        { requestId: args.requestId, details: { id: args.contact_id } },
      );
    }
    await this.contacts.assertLinkable({
      tenant_id: args.tenant_id,
      id: args.contact_id,
      requestId: args.requestId,
      field: 'subject_id',
    });
  }

  async isVisible(args: {
    tenant_id: string;
    contact_id: string;
    visibility: VisibilityContextShape;
  }): Promise<boolean> {
    // include_deleted: a deleted contact the actor can see is still "visible"
    // here, so its existing history stays readable (SD-5) and a new record is
    // refused by assertLinkable with CONTACT_DELETED (H-4), not a bare 404.
    const view = await this.contacts.findByIdForActor({
      tenant_id: args.tenant_id,
      id: args.contact_id,
      visibility: args.visibility,
      include_deleted: true,
    });
    return view !== null;
  }

  async touchLastActivity(args: {
    tenant_id: string;
    contact_id: string;
    at: Date;
  }): Promise<void> {
    await this.contacts.touchLastActivity({
      tenant_id: args.tenant_id,
      id: args.contact_id,
      at: args.at,
    });
  }
}
