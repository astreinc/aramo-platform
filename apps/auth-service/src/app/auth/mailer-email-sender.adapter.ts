import { Inject, Injectable } from '@nestjs/common';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';

import type {
  EmailSender,
  EmailSenderInput,
  EmailSenderResult,
} from './email-sender.port.js';

// Auth-Decoupling PR-2 (ADR-0021 §2) — the Aramo-side adapter that implements
// auth's EmailSender by delegating to @aramo/mailer's MailerPort. This is the
// ONLY seam that imports @aramo/mailer; portal-login.service.ts no longer does
// (the §3.4 decoupling proof).
//
// Pure pass-through: EmailSender mirrors SendEmailInput / SendEmailResult exactly
// (R-P23-2), so there is no field mapping and no behaviour change. A future
// PR-5 scope:auth sweep will keep this adapter OUT of the portable auth core.
@Injectable()
export class MailerEmailSenderAdapter implements EmailSender {
  constructor(@Inject(MAILER_PORT) private readonly mailer: MailerPort) {}

  send(args: EmailSenderInput): Promise<EmailSenderResult> {
    return this.mailer.send(args);
  }
}
