import { Inject, Injectable } from '@nestjs/common';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import { type SigningNotification, type SigningNotificationPort, type SigningNotificationResult } from '@aramo/esign';

// DOC-3 §298 — binds the E-Sign SigningNotificationPort to the generic MailerPort
// (SES / stub by env). E-Sign imports no provider SDK. The signing link (raw
// capability token) is passed to the mailer body but NEVER logged here.
@Injectable()
export class MailerSigningNotificationAdapter implements SigningNotificationPort {
  constructor(@Inject(MAILER_PORT) private readonly mailer: MailerPort) {}

  async notify(input: SigningNotification): Promise<SigningNotificationResult> {
    const subject = `[${input.kind}] ${input.envelope_subject}`;
    const link = input.signing_url ? `<p><a href="${input.signing_url}">Open document</a></p>` : '';
    await this.mailer.send({
      to: input.to_email,
      subject,
      html: `<p>Hello ${input.to_name},</p>${link}`,
      text: `Hello ${input.to_name}. ${input.signing_url ?? ''}`,
    });
    return { delivered: true };
  }
}
