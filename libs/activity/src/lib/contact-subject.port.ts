import type { VisibilityContextShape } from '@aramo/common';

// CONTACTS-1 §8 (H-1..H-4) — the contact-subject seam for Activity.
//
// A recruiter records a note, call or email against a contact through the
// existing manual route (POST /v1/activities, subject_type='contact'). The
// activity lib does not import @aramo/contact (no new nx edge), so the three
// contact-side checks go through THIS port. The concrete adapter is bound by
// the composition root (apps/api) over ContactRepository.
//
//   - assertRecordable: the contact must be visible to the actor (404 when it
//     is not, the same response as an invisible contact read) and must not be
//     deleted (CONTACT_DELETED 422, H-4).
//   - isVisible: read-side visibility for the contact's history (H-3).
//   - touchLastActivity: recency update after a recorded interaction (H-2,
//     later timestamp wins).
export interface ActivityContactSubjectPort {
  assertRecordable(args: {
    tenant_id: string;
    contact_id: string;
    visibility: VisibilityContextShape;
    requestId: string;
  }): Promise<void>;
  isVisible(args: {
    tenant_id: string;
    contact_id: string;
    visibility: VisibilityContextShape;
  }): Promise<boolean>;
  touchLastActivity(args: {
    tenant_id: string;
    contact_id: string;
    at: Date;
  }): Promise<void>;
}

// String injection token (not a class token), as with INTERVIEWER_VALIDATOR.
export const ACTIVITY_CONTACT_SUBJECT = 'ACTIVITY_CONTACT_SUBJECT';

export const CONTACT_SUBJECT_TYPE = 'contact';
