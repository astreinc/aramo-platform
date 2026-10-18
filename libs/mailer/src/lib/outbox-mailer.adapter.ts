import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { SesMailerAdapter } from './ses-mailer.adapter.js';
import { loadMailerConfig } from './mailer.config.js';
import type { MailerPort, SendEmailInput, SendEmailResult } from './mailer.port.js';

// LOCAL DEVELOPMENT ONLY (MAILER_PROVIDER=outbox). Writes each email as one JSON
// file into MAILER_OUTBOX_DIR so a developer can read invitations and open their
// links (tools/local-mail.cjs) without any email service. No network. The config
// loader refuses this provider when NODE_ENV=production.
//
// MAILER_OUTBOX_DELIVER_TO (optional, comma-separated): recipients that ALSO get
// the email for real through SES (needs SES_FROM_ADDRESS) — e.g. the developer's
// own inbox — while every other address stays local, so test addresses never
// bounce off the real sending account.
export function outboxDeliverList(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env['MAILER_OUTBOX_DELIVER_TO'] ?? '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 0),
  );
}

@Injectable()
export class OutboxMailerAdapter implements MailerPort {
  constructor(private readonly ses: SesMailerAdapter) {}

  async send(args: SendEmailInput): Promise<SendEmailResult> {
    if (outboxDeliverList().has(args.to.trim().toLowerCase())) {
      await this.ses.send(args);
    }
    const { outboxDir } = loadMailerConfig();
    if (outboxDir === null) throw new Error('OutboxMailerAdapter invoked without MAILER_OUTBOX_DIR');
    await mkdir(outboxDir, { recursive: true });
    const message_id = `outbox-${randomUUID()}`;
    const sent_at = new Date().toISOString();
    const file = join(outboxDir, `${sent_at.replace(/[:.]/g, '-')}-${message_id}.json`);
    await writeFile(file, JSON.stringify({ message_id, sent_at, to: args.to, subject: args.subject, html: args.html, text: args.text ?? null }, null, 2), 'utf8');
    return { message_id };
  }
}
