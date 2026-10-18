import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { loadMailerConfig } from './mailer.config.js';
import type { MailerPort, SendEmailInput, SendEmailResult } from './mailer.port.js';

// LOCAL DEVELOPMENT ONLY (MAILER_PROVIDER=outbox). Writes each email as one JSON
// file into MAILER_OUTBOX_DIR so a developer can read invitations and open their
// links (tools/local-mail.cjs) without any email service. No network. The config
// loader refuses this provider when NODE_ENV=production.
@Injectable()
export class OutboxMailerAdapter implements MailerPort {
  async send(args: SendEmailInput): Promise<SendEmailResult> {
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
