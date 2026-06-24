import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MailerModule } from '../lib/mailer.module.js';
import { MAILER_PORT } from '../lib/tokens.js';
import { SesMailerAdapter } from '../lib/ses-mailer.adapter.js';
import { StubMailerAdapter } from '../lib/stub-mailer.adapter.js';
import type { MailerPort } from '../lib/mailer.port.js';

// Email-S1 §3 / §6 — the committed DI resolution proof for MAILER_PORT.
//
// Mirrors the cognito/financials/task-assignee binding DI specs: boot the
// REAL module graph and assert what the token resolves to — the regression
// guard category that now gates every CI cycle for each port.
//
// What this proves:
//   1. PROD graph (MAILER_PROVIDER=ses + SES_FROM_ADDRESS) → MAILER_PORT
//      resolves to the REAL SesMailerAdapter, NOT the stub. (the §6 gate)
//   2. Non-prod (MAILER_PROVIDER=stub) → resolves the StubMailerAdapter.
//   3. Fail-LOUD: an unset provider, an invalid provider, and a SES mode
//      without SES_FROM_ADDRESS each throw at module-binding time — never a
//      silent degrade.
//   4. MULTI-INSTANCE IMMUNITY (the cognito bug cannot recur): MailerModule
//      is a pure static leaf (no forRoot), so a nested consumer that imports
//      it resolves the SAME MAILER_PORT instance as the root — one binding,
//      no second class-keyed copy for a binding to leak across.
//
// No real AWS: in prod-graph mode the SES client + its config are lazy
// (SesMailerClientFactory), so resolving/instantiating the adapter touches
// neither SES nor the network. We never call .send().

// A nested consumer used by the multi-instance-immunity proof: it captures
// whatever MAILER_PORT its own module scope resolves.
@Injectable()
class MailConsumerService {
  constructor(@Inject(MAILER_PORT) readonly mailer: MailerPort) {}
}

@Module({
  imports: [MailerModule],
  providers: [MailConsumerService],
  exports: [MailConsumerService],
})
class ConsumerModule {}

describe('Mailer-Binding — MAILER_PORT through real DI', () => {
  const ENV_KEYS = ['MAILER_PROVIDER', 'SES_FROM_ADDRESS', 'AWS_REGION'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('prod graph (MAILER_PROVIDER=ses) binds the REAL SesMailerAdapter (NOT the stub)', async () => {
    process.env['MAILER_PROVIDER'] = 'ses';
    process.env['SES_FROM_ADDRESS'] = 'Aramo Support <support@aramo.ai>';

    const moduleRef = await Test.createTestingModule({
      imports: [MailerModule],
    }).compile();

    const bound = moduleRef.get(MAILER_PORT);
    // The §6 gate: prod resolves the real adapter, where send() actually
    // hits SES — NOT the log-only stub.
    expect(bound).toBeInstanceOf(SesMailerAdapter);
    expect(bound).not.toBeInstanceOf(StubMailerAdapter);
  });

  it('non-prod (MAILER_PROVIDER=stub) binds the StubMailerAdapter', async () => {
    process.env['MAILER_PROVIDER'] = 'stub';
    delete process.env['SES_FROM_ADDRESS'];

    const moduleRef = await Test.createTestingModule({
      imports: [MailerModule],
    }).compile();

    const bound = moduleRef.get(MAILER_PORT);
    expect(bound).toBeInstanceOf(StubMailerAdapter);
    expect(bound).not.toBeInstanceOf(SesMailerAdapter);
  });

  it('fails LOUD when MAILER_PROVIDER is unset', async () => {
    delete process.env['MAILER_PROVIDER'];
    delete process.env['SES_FROM_ADDRESS'];

    await expect(
      Test.createTestingModule({ imports: [MailerModule] }).compile(),
    ).rejects.toThrow(/MAILER_PROVIDER/);
  });

  it('fails LOUD when MAILER_PROVIDER is invalid', async () => {
    process.env['MAILER_PROVIDER'] = 'sendgrid';

    await expect(
      Test.createTestingModule({ imports: [MailerModule] }).compile(),
    ).rejects.toThrow(/MAILER_PROVIDER/);
  });

  it('fails LOUD when MAILER_PROVIDER=ses but SES_FROM_ADDRESS is missing', async () => {
    process.env['MAILER_PROVIDER'] = 'ses';
    delete process.env['SES_FROM_ADDRESS'];

    await expect(
      Test.createTestingModule({ imports: [MailerModule] }).compile(),
    ).rejects.toThrow(/SES_FROM_ADDRESS/);
  });

  it('multi-instance immune: a nested consumer resolves the SAME MAILER_PORT as root (no second instance — the cognito bug cannot recur)', async () => {
    process.env['MAILER_PROVIDER'] = 'ses';
    process.env['SES_FROM_ADDRESS'] = 'Aramo Support <support@aramo.ai>';

    // Root imports MailerModule directly AND a ConsumerModule that ALSO
    // imports MailerModule — the static-import-from-two-places shape.
    const moduleRef = await Test.createTestingModule({
      imports: [MailerModule, ConsumerModule],
    }).compile();

    const rootBound = moduleRef.get(MAILER_PORT);
    const consumer = moduleRef.get(MailConsumerService);

    // Pure static leaf → one class-keyed instance → the consumer injects the
    // very same binding the root resolves. If MailerModule were forRoot'd,
    // these could diverge (the multi-instance collision); it is not, so they
    // are identical.
    expect(consumer.mailer).toBe(rootBound);
    expect(consumer.mailer).toBeInstanceOf(SesMailerAdapter);
  });
});
