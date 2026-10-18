import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMailerConfig } from '../lib/mailer.config.js';
import { OutboxMailerAdapter } from '../lib/outbox-mailer.adapter.js';

// MAILER_PROVIDER=outbox — a LOCAL DEVELOPMENT mailer: each email is written to
// MAILER_OUTBOX_DIR so local signer invitations (and their links) can be opened.
// It must never run in production.

const KEYS = ['MAILER_PROVIDER', 'MAILER_OUTBOX_DIR', 'NODE_ENV'] as const;
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
    const out = await new OutboxMailerAdapter().send({ to: 'sam@x.test', subject: 'Please sign', html: '<a href="http://localhost:4204/s/abc">Review &amp; sign</a>' });
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
