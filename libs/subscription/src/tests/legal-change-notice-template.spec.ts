import { describe, expect, it } from 'vitest';

import {
  LEGAL_CHANGE_NOTICE_TEMPLATE,
  LegalChangeNoticeRefusedError,
  assertTemplateSendable,
  calendarDaysUntil,
  describeLegalChange,
  formatNoticeDate,
  legalChangeAudience,
  parseCalendarDate,
  renderLegalChangeNotice,
  resolveLegalChangeNotice,
  templateSha256,
  type LegalChangeNoticeTemplate,
} from '../lib/legal/legal-change-notice.template.js';
import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from '../lib/legal/legal-documents.js';
import { sendErrorCode } from '../lib/legal/legal-change-notice.service.js';
import { StaticUpcomingLegalChangeSource, UPCOMING_LEGAL_CHANGES, upcomingLegalNotices } from '../lib/legal/upcoming-legal-changes.js';

// Privacy Notice 1.1 remediation E-6 — the notice template, its approval guard and the
// in-service upcoming-notice filter (pure; no database).

const NOW = new Date('2026-10-26T15:30:00.000Z');
const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof LegalChangeNoticeRefusedError) return e.refusal;
    throw e;
  }
  return 'none';
};
const notice = (over: Partial<{ document_key: string; version: string; effective_date: string }> = {}) =>
  resolveLegalChangeNotice({ document_key: 'aramo.privacy_notice', version: '1.1', effective_date: '2026-11-25', now: NOW, ...over });

describe('legal change notice — template status', () => {
  it('ships as DRAFT pending counsel and PO approval', () => {
    expect(LEGAL_CHANGE_NOTICE_TEMPLATE).toEqual({ id: 'aramo.legal_change_notice', version: '0.1.0', status: 'DRAFT' });
  });
});

describe('legal change notice — send approval guard', () => {
  const ref = `${LEGAL_CHANGE_NOTICE_TEMPLATE.id}@${LEGAL_CHANGE_NOTICE_TEMPLATE.version}`;
  it('refuses a DRAFT template without the confirmation', () => {
    expect(refusal(() => assertTemplateSendable(null))).toBe('template_draft');
  });
  it('refuses a confirmation naming another template or version', () => {
    expect(refusal(() => assertTemplateSendable('aramo.legal_change_notice@0.0.9'))).toBe('template_mismatch');
    expect(refusal(() => assertTemplateSendable('other@0.1.0'))).toBe('template_mismatch');
  });
  it('accepts the exact id@version confirmation for a DRAFT template', () => {
    expect(() => assertTemplateSendable(ref)).not.toThrow();
  });
  it('an APPROVED template needs no confirmation, and a wrong one is still refused', () => {
    const approved: LegalChangeNoticeTemplate = { ...LEGAL_CHANGE_NOTICE_TEMPLATE, status: 'APPROVED' };
    expect(() => assertTemplateSendable(null, approved)).not.toThrow();
    expect(refusal(() => assertTemplateSendable('x@1', approved))).toBe('template_mismatch');
  });
});

describe('legal change notice — what may be announced', () => {
  it('resolves the Privacy Notice 1.1 with the Sign-host URLs of the new and current versions', () => {
    const n = notice();
    expect(n.title).toBe('Aramo Privacy Notice');
    expect(n.current.version).toBe('1.0');
    expect(n.current_url).toBe('https://sign.aramo.ai/legal/privacy/1.0');
    expect(n.upcoming_url).toBe('https://sign.aramo.ai/legal/privacy/1.1');
    expect(n.effective_date.toISOString()).toBe('2026-11-25T00:00:00.000Z');
  });
  it('30 calendar days of notice is enough; 29 is refused (UTC dates, time of day ignored)', () => {
    expect(calendarDaysUntil(parseCalendarDate('2026-11-25')!, NOW)).toBe(30);
    expect(() => notice({ effective_date: '2026-11-25' })).not.toThrow();
    expect(refusal(() => notice({ effective_date: '2026-11-24' }))).toBe('notice_period_too_short');
  });
  it('refuses unknown keys, bad versions, bad dates, the current version, and versions with no summary', () => {
    expect(refusal(() => notice({ document_key: 'aramo.nope' }))).toBe('unknown_document');
    expect(refusal(() => notice({ document_key: 'toString' }))).toBe('unknown_document');
    expect(refusal(() => notice({ version: 'v1' }))).toBe('invalid_version');
    expect(refusal(() => notice({ effective_date: '2026-02-30' }))).toBe('invalid_effective_date');
    expect(refusal(() => notice({ version: '1.0' }))).toBe('version_is_current');
    expect(refusal(() => notice({ version: '1.2' }))).toBe('no_change_summary');
  });
  it('refuses a document with no APPROVED published version', () => {
    expect(refusal(() => describeLegalChange('sign.terms_of_service', '0.2.0'))).toBe('no_current_version');
  });
  it('a Personal-only document concerns Personal accounts; the rest concern everyone', () => {
    expect(legalChangeAudience('sign.personal_terms_of_service')).toBe('PERSONAL');
    expect(legalChangeAudience('aramo.privacy_notice')).toBe('ALL');
    expect(legalChangeAudience('aramo.acceptable_use_policy')).toBe('ALL');
  });
});

describe('legal change notice — rendering', () => {
  const r = renderLegalChangeNotice(notice());
  it('subject names the document', () => {
    expect(r.subject).toBe('We are updating the Aramo Privacy Notice');
  });
  it('the text states the version, the effective date, both links, the summary and the contact', () => {
    expect(r.text).toContain('Version 1.1 takes effect on 25 November 2026');
    expect(r.text).toContain('version 1.0 continues to apply');
    expect(r.text).toContain('https://sign.aramo.ai/legal/privacy/1.1');
    expect(r.text).toContain('https://sign.aramo.ai/legal/privacy/1.0');
    expect(r.text).toContain('privacy@aramo.ai');
    expect(r.text).toContain('- It now covers the Aramo Sign mobile app');
  });
  it('the HTML carries the same links and escapes the text', () => {
    expect(r.html).toContain('<a href="https://sign.aramo.ai/legal/privacy/1.1">');
    expect(r.html).toContain('<a href="https://sign.aramo.ai/legal/privacy/1.0">');
    expect(r.html).toContain('mailto:privacy@aramo.ai');
    const odd = renderLegalChangeNotice({ ...notice(), summary: ['<b>"A" & \'B\'</b>'] });
    expect(odd.html).toContain('<li>&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt;</li>');
  });
  it('is the same for every recipient (no personal data)', () => {
    expect(renderLegalChangeNotice(notice())).toEqual(r);
  });
  it('formats calendar dates without a time-zone shift', () => {
    expect(formatNoticeDate(parseCalendarDate('2027-01-01')!)).toBe('1 January 2027');
  });
});

describe('legal change notice — template fingerprint', () => {
  it('is stable, and changes with the template version or the summary', () => {
    const a = templateSha256('aramo.privacy_notice', '1.1');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(templateSha256('aramo.privacy_notice', '1.1')).toBe(a);
    expect(templateSha256('aramo.privacy_notice', '1.1', { ...LEGAL_CHANGE_NOTICE_TEMPLATE, version: '0.1.1' })).not.toBe(a);
    expect(templateSha256('aramo.privacy_notice', '1.1', LEGAL_CHANGE_NOTICE_TEMPLATE, { 'aramo.privacy_notice@1.1': ['changed'] })).not.toBe(a);
  });
});

describe('send error codes', () => {
  it('keeps a short provider error name, never the message text', () => {
    const e = Object.assign(new Error('Email address is not verified: someone@example.com'), { name: 'MessageRejected' });
    expect(sendErrorCode(e)).toBe('MessageRejected');
    expect(sendErrorCode(new Error('x@y.z failed'))).toBe('send_failed');
    expect(sendErrorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(sendErrorCode('boom')).toBe('send_failed');
  });
});

describe('in-service notice — upcoming changes', () => {
  const src = (list: { key: 'aramo.privacy_notice' | 'sign.personal_terms_of_service' | 'sign.terms_of_service'; version: string; effective_date: string }[]) =>
    new StaticUpcomingLegalChangeSource(list);

  it('the governed default list is empty: nothing is announced on deploy', () => {
    expect(UPCOMING_LEGAL_CHANGES).toEqual([]);
    expect(upcomingLegalNotices(new StaticUpcomingLegalChangeSource(), 'BUSINESS', NOW)).toEqual([]);
  });
  it('lists a change until the day before it takes effect', () => {
    const s = src([{ key: 'aramo.privacy_notice', version: '1.1', effective_date: '2026-11-25' }]);
    expect(upcomingLegalNotices(s, 'BUSINESS', NOW)).toEqual([
      {
        key: 'aramo.privacy_notice',
        title: 'Aramo Privacy Notice',
        version: '1.1',
        effective_date: '2026-11-25',
        url: 'https://sign.aramo.ai/legal/privacy/1.1',
        current_version: '1.0',
        current_url: 'https://sign.aramo.ai/legal/privacy/1.0',
      },
    ]);
    expect(upcomingLegalNotices(s, 'BUSINESS', new Date('2026-11-24T23:59:00Z'))).toHaveLength(1);
    expect(upcomingLegalNotices(s, 'BUSINESS', new Date('2026-11-25T00:00:00Z'))).toEqual([]);
  });
  it('a Personal-only document is not shown to a Business account', () => {
    const s = src([{ key: 'sign.personal_terms_of_service', version: '1.1', effective_date: '2026-12-31' }]);
    expect(upcomingLegalNotices(s, 'BUSINESS', NOW)).toEqual([]);
    expect(upcomingLegalNotices(s, 'PERSONAL', NOW)).toHaveLength(1);
  });
  it('skips entries that do not describe a real change', () => {
    const s = src([
      { key: 'sign.terms_of_service', version: '0.2.0', effective_date: '2026-12-31' },
      { key: 'aramo.privacy_notice', version: '1.0', effective_date: '2026-12-31' },
      { key: 'aramo.privacy_notice', version: '1.1', effective_date: 'soon' },
    ]);
    expect(upcomingLegalNotices(s, 'PERSONAL', NOW)).toEqual([]);
  });
  it('follows the registry it is given (a newer approved version moves the "current" link)', () => {
    const reg: LegalDocumentVersion[] = [
      ...LEGAL_DOCUMENTS,
      { key: 'aramo.privacy_notice', version: '1.1', status: 'APPROVED', path: 'x', sha256: 'a'.repeat(64), url: 'https://sign.aramo.ai/legal/privacy/1.1' },
    ];
    const s = src([{ key: 'aramo.privacy_notice', version: '1.2', effective_date: '2027-01-31' }]);
    expect(upcomingLegalNotices(s, 'BUSINESS', NOW, reg)[0]?.current_version).toBe('1.1');
  });
});
