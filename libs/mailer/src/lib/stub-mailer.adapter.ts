import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';

import type { MailerPort, SendEmailInput, SendEmailResult } from './mailer.port.js';

// Email-S1 §1.3 — StubMailerAdapter: the non-prod (local/dev/test) mailer.
//
// Mirrors libs/engagement SendStubDeliveryProvider: an in-process adapter
// that performs NO network I/O — no SES, no SMTP. It returns a synthetic
// message_id so callers can correlate, exactly as the engagement-delivery
// stub does.
//
// FAIL-LOUD, NOT SILENT: unlike a no-op that masquerades as a successful
// send, this stub logs at WARN that NO real email was sent, naming the
// recipient + subject. The point is that a prod box accidentally bound to
// the stub (MAILER_PROVIDER misconfigured) screams in the logs rather than
// silently swallowing invite email. The body is NEVER logged.

@Injectable()
export class StubMailerAdapter implements MailerPort {
  constructor(
    @Inject('StubMailerAdapterLogger') private readonly logger: AramoLogger,
  ) {}

  async send(args: SendEmailInput): Promise<SendEmailResult> {
    const message_id = `stub-${randomUUID()}`;
    this.logger.warn({
      event: 'mailer.stub.no_send',
      message:
        'StubMailerAdapter: NO real email sent (MAILER_PROVIDER=stub). ' +
        'If this is production, email delivery is misconfigured.',
      to: args.to,
      subject: args.subject,
      message_id,
    });
    return { message_id };
  }
}
