import {
  type SendEmailCommandInput,
  SendEmailCommand,
  type SESv2Client,
} from '@aws-sdk/client-sesv2';
import { Inject, Injectable } from '@nestjs/common';

import { type IntakeConfig, loadIntakeConfig } from './intake.config.js';
import { INTAKE_SES_CLIENT } from './tokens.js';

// Standalone SESv2 send — mirrors the audited libs/mailer SESv2 pattern
// (PATTERN REFERENCE ONLY; no @aramo/* import). From no-reply@, to hello@,
// reply-to the submitter, plain-text Content.Simple, UTF-8 (R-PUB5-5). The
// email is the record — nothing is persisted. Credentials: SDK default chain
// (never hardcoded), region from env.
export interface WorkspaceRequestPayload {
  name: string;
  email: string;
  firm: string;
  message?: string;
}

export interface ContactPayload {
  name: string;
  email: string;
  message: string;
}

@Injectable()
export class IntakeMailerService {
  private readonly config: IntakeConfig = loadIntakeConfig();

  constructor(
    @Inject(INTAKE_SES_CLIENT) private readonly client: SESv2Client,
  ) {}

  buildWorkspaceRequestInput(
    payload: WorkspaceRequestPayload,
  ): SendEmailCommandInput {
    const body = [
      `Name: ${payload.name}`,
      `Work email: ${payload.email}`,
      `Firm: ${payload.firm}`,
      `Message: ${payload.message ?? '(none)'}`,
    ].join('\n');
    return this.buildInput(
      `[Aramo intake] workspace request — ${payload.firm}`,
      body,
      payload.email,
    );
  }

  buildContactInput(payload: ContactPayload): SendEmailCommandInput {
    const body = [
      `Name: ${payload.name}`,
      `Email: ${payload.email}`,
      `Message: ${payload.message}`,
    ].join('\n');
    return this.buildInput(
      `[Aramo intake] contact — ${payload.name}`,
      body,
      payload.email,
    );
  }

  async sendWorkspaceRequest(payload: WorkspaceRequestPayload): Promise<void> {
    await this.send(this.buildWorkspaceRequestInput(payload));
  }

  async sendContact(payload: ContactPayload): Promise<void> {
    await this.send(this.buildContactInput(payload));
  }

  private buildInput(
    subject: string,
    text: string,
    replyTo: string,
  ): SendEmailCommandInput {
    return {
      FromEmailAddress: this.config.fromAddress,
      Destination: { ToAddresses: [this.config.toAddress] },
      ReplyToAddresses: [replyTo],
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        },
      },
    };
  }

  private async send(input: SendEmailCommandInput): Promise<void> {
    await this.client.send(new SendEmailCommand(input));
  }
}
