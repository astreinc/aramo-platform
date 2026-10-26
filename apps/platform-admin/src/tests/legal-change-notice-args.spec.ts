import { describe, expect, it } from 'vitest';

import { LegalChangeNoticeUsageError, parseLegalChangeNoticeArgs } from '../app/legal-notice/legal-change-notice.args.js';

// Privacy Notice 1.1 remediation E-6 — the operator command's arguments (pure).

const BASE = ['--document', 'aramo.privacy_notice', '--version', '1.1', '--effective-date', '2026-11-25'];
const usage = (argv: string[]): string => {
  try {
    parseLegalChangeNoticeArgs(argv);
  } catch (e) {
    if (e instanceof LegalChangeNoticeUsageError) return e.message;
    throw e;
  }
  return 'ok';
};

describe('legal-change-notice arguments', () => {
  it('a dry run needs only the document, version and effective date', () => {
    expect(parseLegalChangeNoticeArgs([...BASE, '--dry-run'])).toEqual({
      mode: 'DRY_RUN',
      document_key: 'aramo.privacy_notice',
      version: '1.1',
      effective_date: '2026-11-25',
      approved_template: null,
      authorization_ref: null,
      rate_per_second: 2,
      resend_in_doubt: false,
    });
  });

  it('send mode carries the approval confirmation, authorization reference, rate and resend flag (= form too)', () => {
    expect(
      parseLegalChangeNoticeArgs([...BASE, '--send', '--approved-template=aramo.legal_change_notice@0.1.0', '--authorization-ref', 'PO-2026-10-27', '--rate', '5', '--resend-in-doubt']),
    ).toMatchObject({ mode: 'SEND', approved_template: 'aramo.legal_change_notice@0.1.0', authorization_ref: 'PO-2026-10-27', rate_per_second: 5, resend_in_doubt: true });
  });

  it('needs exactly one of --dry-run and --send (sending is never the default)', () => {
    expect(usage(BASE)).toMatch(/exactly one/);
    expect(usage([...BASE, '--dry-run', '--send'])).toMatch(/exactly one/);
  });

  it('refuses send-only options on a dry run', () => {
    expect(usage([...BASE, '--dry-run', '--approved-template', 'x@1'])).toMatch(/--send only/);
    expect(usage([...BASE, '--dry-run', '--resend-in-doubt'])).toMatch(/--send only/);
  });

  it('refuses missing values, repeats, unknown arguments and a bad rate', () => {
    expect(usage(['--version', '1.1', '--effective-date', '2026-11-25', '--dry-run'])).toMatch(/--document is required/);
    expect(usage([...BASE, '--send', '--rate'])).toMatch(/needs a value/);
    expect(usage([...BASE, '--send', '--rate', '--resend-in-doubt'])).toMatch(/needs a value/);
    expect(usage([...BASE, '--version', '1.2', '--dry-run'])).toMatch(/given twice/);
    expect(usage([...BASE, '--dry-run', '--to', 'someone@example.com'])).toMatch(/unknown argument/);
    expect(usage([...BASE, '--send', '--rate', '0'])).toMatch(/positive/);
  });
});
