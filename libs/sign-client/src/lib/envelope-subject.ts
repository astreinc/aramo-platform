// An envelope's email subject — ONE rule for Sign web, the Aramo Sign app and the signing
// emails (sign-service). PO 2026-11-18 (DocuSign comparison): the editors start the subject as
// "Please sign: {first document}", and the sender may edit it. The signature-request email uses
// the subject AS WRITTEN (adding "Please sign: " only when it is not there yet: an older
// envelope, a template or the API may give a bare title), and every other line names the
// document WITHOUT the prefix ("You've been asked to review and sign "Lease"", "Completed: Lease").
// Field test 2026-11-24: the email added its own prefix to the editors' and sent
// "Please sign: Please sign: Lease".
//
// Pure TypeScript ESM, no dependency (type:client-shared).

/** The prefix the editors start a subject with. */
export const SIGN_SUBJECT_PREFIX = 'Please sign: ';

const PREFIX = /^\s*please\s+sign\s*:\s*/i;

/** The subject without a leading "Please sign:" (any case or spacing); the subject itself if that leaves nothing. */
export function subjectDocumentTitle(subject: string): string {
  const title = subject.replace(PREFIX, '').trim();
  return title.length > 0 ? title : subject.trim();
}

/** The signature-request email's subject: the sender's subject, with "Please sign: " added only when missing. */
export function signatureRequestSubject(subject: string): string {
  return PREFIX.test(subject) ? subject.trim() : `${SIGN_SUBJECT_PREFIX}${subject.trim()}`;
}
