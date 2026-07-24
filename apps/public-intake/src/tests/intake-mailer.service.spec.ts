import type { SESv2Client } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';

import { IntakeMailerService } from '../app/intake/intake-mailer.service.js';

// §1.10 — mail-payload shape with the SES client mocked. Asserts the audited
// libs/mailer semantics (from no-reply@, to hello@, reply-to submitter,
// Content.Simple plain text, UTF-8) and the R-PUB5-5 subject lines.
describe('IntakeMailerService', () => {
  const fakeClient = (): SESv2Client =>
    ({ send: vi.fn().mockResolvedValue({}) }) as unknown as SESv2Client;

  it('builds a workspace-request email with the correct shape', () => {
    const svc = new IntakeMailerService(fakeClient());
    const input = svc.buildWorkspaceRequestInput({
      name: 'Ada Lovelace',
      email: 'ada@firm.example',
      firm: 'Analytical Engines Ltd',
      message: 'We run an IT desk.',
    });

    expect(input.FromEmailAddress).toBe('no-reply@aramo.ai');
    expect(input.Destination?.ToAddresses).toEqual(['hello@aramo.ai']);
    expect(input.ReplyToAddresses).toEqual(['ada@firm.example']);
    expect(input.Content?.Simple?.Subject?.Data).toBe(
      '[Aramo intake] workspace request — Analytical Engines Ltd',
    );
    expect(input.Content?.Simple?.Subject?.Charset).toBe('UTF-8');
    const body = input.Content?.Simple?.Body?.Text?.Data ?? '';
    expect(body).toContain('Name: Ada Lovelace');
    expect(body).toContain('Work email: ada@firm.example');
    expect(body).toContain('Firm: Analytical Engines Ltd');
  });

  it('builds a contact email with the correct subject', () => {
    const svc = new IntakeMailerService(fakeClient());
    const input = svc.buildContactInput({
      name: 'Bo',
      email: 'bo@example.com',
      message: 'Hello there.',
    });
    expect(input.Content?.Simple?.Subject?.Data).toBe(
      '[Aramo intake] contact — Bo',
    );
    expect(input.ReplyToAddresses).toEqual(['bo@example.com']);
  });

  it('sends exactly one SES command', async () => {
    const client = fakeClient();
    const svc = new IntakeMailerService(client);
    await svc.sendContact({
      name: 'Cy',
      email: 'cy@example.com',
      message: 'hi',
    });
    expect(client.send).toHaveBeenCalledOnce();
  });
});
