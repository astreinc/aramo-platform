import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMailerConfig } from '../lib/mailer.config.js';
import { OutboxMailerAdapter } from '../lib/outbox-mailer.adapter.js';

// MAILER_PROVIDER=outbox — a LOCAL DEVELOPMENT mailer: each email is written to
// MAILER_OUTBOX_DIR so local signer invitations (and their links) can be opened.
// It must never run in production.

const KEYS = ['MAILER_PROVIDER', 'MAILER_OUTBOX_DIR', 'NODE_ENV', 'MAILER_OUTBOX_DELIVER_TO', 'SES_FROM_ADDRESS'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('outbox mailer (local development)', () => {
  it('writes the full email (incl. links) as JSON into MAILER_OUTBOX_DIR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    dirs.push(dir);
    process.env['MAILER_PROVIDER'] = 'outbox';
    process.env['MAILER_OUTBOX_DIR'] = dir;
    delete process.env['NODE_ENV'];
    const out = await new OutboxMailerAdapter({ send: async () => ({ message_id: 'x' }) } as never).send({ to: 'sam@x.test', subject: 'Please sign', html: '<a href="http://localhost:4204/s/abc">Review &amp; sign</a>' });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const mail = JSON.parse(readFileSync(join(dir, files[0] as string), 'utf8')) as Record<string, unknown>;
    expect(mail).toMatchObject({ message_id: out.message_id, to: 'sam@x.test', subject: 'Please sign' });
    expect(String(mail['html'])).toContain('http://localhost:4204/s/abc');
  });

  it('is refused in production and requires MAILER_OUTBOX_DIR', () => {
    process.env['MAILER_PROVIDER'] = 'outbox';
    process.env['MAILER_OUTBOX_DIR'] = '/tmp/x';
    process.env['NODE_ENV'] = 'production';
    expect(() => loadMailerConfig()).toThrow(/must not be used in production/);
    delete process.env['NODE_ENV'];
    delete process.env['MAILER_OUTBOX_DIR'];
    expect(() => loadMailerConfig()).toThrow(/MAILER_OUTBOX_DIR/);
  });
});

describe('outbox mailer — real delivery allowlist', () => {
  it('sends through SES only for listed recipients and still writes the local copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    dirs.push(dir);
    process.env['MAILER_PROVIDER'] = 'outbox';
    process.env['MAILER_OUTBOX_DIR'] = dir;
    process.env['MAILER_OUTBOX_DELIVER_TO'] = 'Dev@Inbox.test, other@x.test';
    process.env['SES_FROM_ADDRESS'] = 'Aramo <support@aramo.ai>';
    delete process.env['NODE_ENV'];
    const sent: string[] = [];
    const adapter = new OutboxMailerAdapter({ send: async (a: { to: string }) => { sent.push(a.to); return { message_id: 's' }; } } as never);
    await adapter.send({ to: 'dev@inbox.test', subject: 's', html: 'h' });
    await adapter.send({ to: 'sam@example.com', subject: 's', html: 'h' });
    expect(sent).toEqual(['dev@inbox.test']);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('requires SES_FROM_ADDRESS when a real-delivery allowlist is set', () => {
    process.env['MAILER_PROVIDER'] = 'outbox';
    process.env['MAILER_OUTBOX_DIR'] = '/tmp/x';
    process.env['MAILER_OUTBOX_DELIVER_TO'] = 'dev@inbox.test';
    delete process.env['SES_FROM_ADDRESS'];
    delete process.env['NODE_ENV'];
    expect(() => loadMailerConfig()).toThrow(/SES_FROM_ADDRESS/);
  });
});
