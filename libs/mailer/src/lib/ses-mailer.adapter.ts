import { Inject, Injectable } from '@nestjs/common';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { AramoError, type AramoLogger } from '@aramo/common';

import type { MailerPort, SendEmailInput, SendEmailResult } from './mailer.port.js';
import { SesMailerClientFactory } from './ses-mailer-client.factory.js';

// Email-S1 §1.2 — SesMailerAdapter: the REAL transactional-email adapter.
//
// Sends via SESv2 SendEmailCommand. The FROM address is fixed config
// (SES_FROM_ADDRESS), NEVER a caller argument — every send is pinned to it.
// It is passed VERBATIM to FromEmailAddress, so it accepts RFC-5322
// display-name format ("Aramo Support <support@aramo.ai>"); SES + the IAM
// ses:FromAddress condition key on the address part only (support@aramo.ai),
// so the display name does not affect the grant (Email-S1 §2.1). Region +
// credentials come from the SESv2
// client factory (SDK default chain — same path the S3 résumé adapter
// uses; no explicit creds).
//
// S1 sends PRE-RENDERED html/text — there is no templating here. Subject /
// html / text are the caller's final content.

@Injectable()
export class SesMailerAdapter implements MailerPort {
  constructor(
    private readonly clientFactory: SesMailerClientFactory,
    @Inject('SesMailerAdapterLogger') private readonly logger: AramoLogger,
  ) {}

  async send(args: SendEmailInput): Promise<SendEmailResult> {
    const { fromAddress } = this.clientFactory.getConfig();
    // Belt-and-braces: the adapter is only bound when MAILER_PROVIDER=ses,
    // and loadMailerConfig already rejects that mode without a from-address.
    // This guard makes the invariant local + fail-loud at the send site.
    if (fromAddress === null) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'SesMailerAdapter invoked without SES_FROM_ADDRESS configured',
        500,
        { requestId: 'mailer-send', details: { kind: 'env_missing', name: 'SES_FROM_ADDRESS' } },
      );
    }

    const client = this.clientFactory.getClient();
    const out = await client.send(
      new SendEmailCommand({
        FromEmailAddress: fromAddress,
        Destination: { ToAddresses: [args.to] },
        Content: {
          Simple: {
            Subject: { Data: args.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: args.html, Charset: 'UTF-8' },
              ...(args.text !== undefined
                ? { Text: { Data: args.text, Charset: 'UTF-8' } }
                : {}),
            },
          },
        },
      }),
    );

    const message_id = out.MessageId ?? '';
    // Log the send fact (recipient + subject), never the body.
    this.logger.log({
      event: 'mailer.ses.sent',
      to: args.to,
      subject: args.subject,
      message_id,
    });
    return { message_id };
  }
}
