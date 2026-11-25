import { describe, expect, it } from 'vitest';

import { renderSigningNotification } from '../app/mailer-signing-notification.adapter.js';

// Field test 2026-11-24 — Sign web and the app start a subject as "Please sign: {document}" (PO
// 2026-11-18), and the request email added its own prefix: "Please sign: Please sign: Normal pdf".
// The one subject rule (@aramo/sign-client): the request subject is the sender's subject as
// written; every other line names the document without the prefix.
const base = { to_email: 'a@x.test', to_name: 'A', envelope_subject: 'Please sign: Normal pdf' } as const;

describe('signing emails and the "Please sign:" subject', () => {
  it('the request email does not double the prefix, and its text names the document', () => {
    const r = renderSigningNotification({ ...base, kind: 'SIGNATURE_REQUEST', signing_url: 'https://sign.x/s/t' });
    expect(r.subject).toBe('Please sign: Normal pdf');
    expect(r.lines[0]).toBe('You\'ve been asked to review and sign "Normal pdf".');
  });

  it('a bare subject still gets the prefix on the request email', () => {
    expect(renderSigningNotification({ ...base, envelope_subject: 'Normal pdf', kind: 'SIGNATURE_REQUEST', signing_url: 'https://sign.x/s/t' }).subject).toBe('Please sign: Normal pdf');
  });

  it('the other emails name the document without the prefix', () => {
    expect(renderSigningNotification({ ...base, kind: 'SIGNATURE_REMINDER', signing_url: 'https://sign.x/s/t' }).subject).toBe('Reminder: please sign Normal pdf');
    expect(renderSigningNotification({ ...base, kind: 'SIGNATURE_COMPLETED', download_url: 'https://sign.x/d/t' }).subject).toBe('Completed: Normal pdf');
    expect(renderSigningNotification({ ...base, kind: 'RECIPIENT_COPY', recipient_role: 'COPY', copy_url: 'https://sign.x/c/t' }).subject).toBe('For your records: Normal pdf');
  });
});
