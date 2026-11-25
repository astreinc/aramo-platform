// Runs under vitest and mobile Jest (globals only).
import { SIGN_SUBJECT_PREFIX, signatureRequestSubject, subjectDocumentTitle } from '../index.js';

// Field test 2026-11-24 — the email added "Please sign: " to a subject that already had it.
describe('envelope email subject', () => {
  it('the request email uses the subject as written when it already says "Please sign:"', () => {
    expect(signatureRequestSubject('Please sign: Normal pdf')).toBe('Please sign: Normal pdf');
    expect(signatureRequestSubject('please sign:Normal pdf')).toBe('please sign:Normal pdf');
  });
  it('adds the prefix to a bare title (an older envelope, a template, the API)', () => {
    expect(signatureRequestSubject('Normal pdf')).toBe(`${SIGN_SUBJECT_PREFIX}Normal pdf`);
  });
  it('a sender’s own wording is kept as written in the request subject', () => {
    expect(signatureRequestSubject('Offer letter for Jo — please review')).toBe('Please sign: Offer letter for Jo — please review');
  });
  it('the document title drops the prefix; a subject that is only the prefix stays as is', () => {
    expect(subjectDocumentTitle('Please sign: Normal pdf')).toBe('Normal pdf');
    expect(subjectDocumentTitle('  PLEASE  SIGN :  Lease ')).toBe('Lease');
    expect(subjectDocumentTitle('Lease')).toBe('Lease');
    expect(subjectDocumentTitle('Please sign:')).toBe('Please sign:');
  });
});
