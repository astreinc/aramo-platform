import { NestFactory } from '@nestjs/core';
import { IdentityRepository } from '@aramo/identity';
import { MAILER_PORT, loadMailerConfig, type MailerPort } from '@aramo/mailer';
import { LegalChangeNoticeRefusedError, LegalChangeNoticeRepository, LegalChangeNoticeService, type LegalNoticeMailer } from '@aramo/subscription';

import { LegalChangeNoticeCliModule } from './app/legal-notice/legal-change-notice-cli.module.js';
import { LEGAL_CHANGE_NOTICE_USAGE, LegalChangeNoticeUsageError, parseLegalChangeNoticeArgs } from './app/legal-notice/legal-change-notice.args.js';

// Privacy Notice 1.1 remediation E-6 (Aramo-Privacy-Notice-1_1-Remediation-Directive-v1_0-LOCKED,
// decision 7) — the OPERATOR command that notifies every active account holder of an upcoming
// legal-document version. Nothing runs it automatically: not at deploy, not at boot, not on a
// schedule. Run on the box in the platform-admin image, for example:
//
//   docker compose -p aramo-singlebox -f docker-compose.prod.yml run --rm platform-admin \
//     node dist/apps/platform-admin/src/legal-change-notice.main.js \
//     --document aramo.privacy_notice --version 1.1 --effective-date 2026-11-25 --dry-run
//
// --dry-run prints COUNTS only (no addresses) and sends nothing. --send additionally needs
// --approved-template <id@version> while the template is DRAFT and --authorization-ref <ref>.
// Re-running --send is safe: delivered recipients are skipped, failed ones retried.
//
// Exit codes: 0 completed with nothing failed or in doubt; 1 completed with failures or in-doubt
// recipients (re-run to resume); 2 refused or could not run.

function scriptArgs(): string[] {
  const i = process.argv.findIndex((a) => /legal-change-notice\.main\.(ts|js)$/.test(a));
  return process.argv.slice(i < 0 ? 2 : i + 1);
}

async function main(): Promise<number> {
  const args = parseLegalChangeNoticeArgs(scriptArgs());
  const app = await NestFactory.createApplicationContext(LegalChangeNoticeCliModule.forMode(args.mode), { logger: ['error', 'warn'] });
  try {
    const identity = app.get(IdentityRepository);
    const mailer: LegalNoticeMailer =
      args.mode === 'SEND'
        ? app.get<MailerPort>(MAILER_PORT)
        : {
            send: () => Promise.reject(new Error('a dry run never sends')),
          };
    const service = new LegalChangeNoticeService({
      repository: app.get(LegalChangeNoticeRepository),
      holders: { activeAccountHolders: (a) => identity.listActiveAccountHolders(a) },
      mailer,
      provider: args.mode === 'SEND' ? loadMailerConfig().provider : 'none',
    });
    const r = await service.run(args);
    console.log(
      JSON.stringify({
        event: 'legal_change_notice_run',
        run_id: r.run_id,
        mode: r.mode,
        document: `${r.document_key}@${r.version}`,
        effective_date: r.effective_date,
        template: r.template,
        template_sha256: r.template_sha256,
        recipients: r.eligible_count,
        ...(r.mode === 'DRY_RUN'
          ? { would_send: r.would_send_count, already_done: r.already_done_count, in_doubt: r.in_doubt_count }
          : { sent: r.sent_count, failed: r.failed_count, suppressed: r.suppressed_count, already_done: r.already_done_count, in_doubt: r.in_doubt_count }),
      }),
    );
    return r.mode === 'SEND' && (r.failed_count > 0 || r.in_doubt_count > 0) ? 1 : 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof LegalChangeNoticeUsageError) {
      console.error(`[legal-change-notice] ${err.message}\n${LEGAL_CHANGE_NOTICE_USAGE}`);
    } else if (err instanceof LegalChangeNoticeRefusedError) {
      console.error(`[legal-change-notice] REFUSED (${err.refusal}): ${err.message}`);
    } else {
      console.error(`[legal-change-notice] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(2);
  });
