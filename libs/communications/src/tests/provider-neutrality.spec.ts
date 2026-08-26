import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeVoiceProvider } from '../lib/provider/fake/fake-voice-provider.js';
import { VoiceProviderRegistry } from '../lib/provider/voice-provider.registry.js';

// COMM-B1 — provider neutrality proofs. (1) The fake provider normalizes a
// generic provider event into a canonical state WITHOUT any provider-specific
// coupling. (2) No provider (Zoom) vocabulary leaks into the canonical domain
// source (domain/ + the port/registry) — provider terms are confined to
// provider/<vendor>/ adapters, of which B1 ships none.

describe('FakeVoiceProvider normalization', () => {
  it('normalizes a provider event to an already-mapped canonical target_status', async () => {
    const fake = new FakeVoiceProvider();
    const normalized = await fake.normalizeWebhook({
      provider_event_key: 'evt-1',
      event_type: 'call.ringing',
      target_status: 'ringing',
      provider_call_element_id: 'elem-9',
    });
    expect(normalized.target_status).toBe('ringing');
    expect(normalized.provider_event_key).toBe('evt-1');
    expect(normalized.provider_call_element_id).toBe('elem-9');
  });

  it('reports outbound-voice capability and a launch mode', async () => {
    const fake = new FakeVoiceProvider();
    expect(fake.getCapabilities().voice.outbound).toBe(true);
    const launch = await fake.initiateCall({
      tenant_id: 't',
      integration_connection_id: 'c',
      channel: 'voice',
      direction: 'outbound',
      from_address: '+15715550100',
      to_address: '+17035550111',
    });
    expect(launch.launch_mode).toBe('fake_embed');
    expect(launch.provider_call_id).toMatch(/^fake-call-/);
  });
});

describe('VoiceProviderRegistry', () => {
  it('ships empty and resolves a registered provider by its key', () => {
    const reg = new VoiceProviderRegistry();
    expect(reg.resolve('fake_voice')).toBeNull();
    const fake = new FakeVoiceProvider();
    reg.register(fake);
    expect(reg.has('fake_voice')).toBe(true);
    expect(reg.resolve('fake_voice')).toBe(fake);
    expect(reg.resolve('unknown_provider')).toBeNull();
  });
});

describe('no provider vocabulary leaks into the canonical domain', () => {
  const DOMAIN_DIR = resolve(__dirname, '../lib/domain');
  const PORT_FILES = [
    resolve(__dirname, '../lib/provider/voice-provider.port.ts'),
    resolve(__dirname, '../lib/provider/voice-provider.registry.ts'),
  ];

  function collectTs(dir: string): string[] {
    return readdirSync(dir)
      .map((n) => resolve(dir, n))
      .filter((p) => statSync(p).isFile() && p.endsWith('.ts'))
      .concat(
        readdirSync(dir)
          .map((n) => resolve(dir, n))
          .filter((p) => statSync(p).isDirectory())
          .flatMap((sub) => collectTs(sub)),
      );
  }

  it('domain/ and the provider port carry no vendor terminology', () => {
    const files = [...collectTs(DOMAIN_DIR), ...PORT_FILES];
    // Vendor/product terms that must never appear in the provider-neutral core.
    const banned = /\b(zoom|ringcentral|teams|smart[_-]?embed|call[_-]?log)\b/i;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(banned.test(text), `${file} contains provider vocabulary`).toBe(false);
    }
  });
});
