// Privacy Notice 1.1 remediation E-6 — argument parsing for the operator command
// (apps/platform-admin/src/legal-change-notice.main.ts). Pure: no I/O.
//
//   --document <key> --version <v> --effective-date <YYYY-MM-DD> (--dry-run | --send)
//   [--approved-template <template id>@<template version>]   send only: confirms the approved text
//   [--authorization-ref <ref>]                              send only, required: the authorization
//   [--rate <emails per second>]                             send only, default 2, at most 14
//   [--resend-in-doubt]                                      send only: retry rows an interrupted run left PENDING

export class LegalChangeNoticeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegalChangeNoticeUsageError';
  }
}

export interface LegalChangeNoticeArgs {
  mode: 'DRY_RUN' | 'SEND';
  document_key: string;
  version: string;
  effective_date: string;
  approved_template: string | null;
  authorization_ref: string | null;
  rate_per_second: number;
  resend_in_doubt: boolean;
}

export const LEGAL_CHANGE_NOTICE_USAGE =
  'usage: legal-change-notice --document <key> --version <v> --effective-date <YYYY-MM-DD> (--dry-run | --send) ' +
  '[--approved-template <id@version>] [--authorization-ref <ref>] [--rate <per second>] [--resend-in-doubt]';

const VALUE_FLAGS = new Set(['--document', '--version', '--effective-date', '--approved-template', '--authorization-ref', '--rate']);
const BOOL_FLAGS = new Set(['--dry-run', '--send', '--resend-in-doubt']);
const SEND_ONLY = ['--approved-template', '--authorization-ref', '--rate', '--resend-in-doubt'];

export function parseLegalChangeNoticeArgs(argv: readonly string[]): LegalChangeNoticeArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;
    const eq = raw.indexOf('=');
    const name = eq > 0 ? raw.slice(0, eq) : raw;
    if (VALUE_FLAGS.has(name)) {
      const v = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (v === undefined || v.length === 0 || (eq < 0 && v.startsWith('--'))) throw new LegalChangeNoticeUsageError(`${name} needs a value`);
      if (values.has(name)) throw new LegalChangeNoticeUsageError(`${name} given twice`);
      values.set(name, v);
    } else if (BOOL_FLAGS.has(name) && eq < 0) {
      flags.add(name);
    } else {
      throw new LegalChangeNoticeUsageError(`unknown argument: ${raw}`);
    }
  }
  const dry = flags.has('--dry-run');
  const send = flags.has('--send');
  if (dry === send) throw new LegalChangeNoticeUsageError('give exactly one of --dry-run or --send');
  for (const req of ['--document', '--version', '--effective-date']) {
    if (!values.has(req)) throw new LegalChangeNoticeUsageError(`${req} is required`);
  }
  if (dry) {
    const extra = SEND_ONLY.find((f) => values.has(f) || flags.has(f));
    if (extra !== undefined) throw new LegalChangeNoticeUsageError(`${extra} applies to --send only`);
  }
  let rate = 2;
  if (values.has('--rate')) {
    rate = Number(values.get('--rate'));
    if (!Number.isFinite(rate) || rate <= 0) throw new LegalChangeNoticeUsageError('--rate must be a positive number');
  }
  return {
    mode: dry ? 'DRY_RUN' : 'SEND',
    document_key: values.get('--document')!,
    version: values.get('--version')!,
    effective_date: values.get('--effective-date')!,
    approved_template: values.get('--approved-template') ?? null,
    authorization_ref: values.get('--authorization-ref') ?? null,
    rate_per_second: rate,
    resend_in_doubt: flags.has('--resend-in-doubt'),
  };
}
