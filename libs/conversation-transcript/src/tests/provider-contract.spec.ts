import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FakeConversationTranscriptProvider,
  FAKE_TRANSCRIPT_PROVIDER_KEY,
} from '../lib/provider/fake/fake-conversation-transcript-provider.js';
import {
  isTranscriptionAuthorized,
} from '../lib/ports/transcription-authorization.js';

const LIB_SRC = resolve(__dirname, '..');

describe('CI-B3 provider-neutral acquisition contract', () => {
  it('capability contract declares recording_dependency (provider-declared, not global)', () => {
    const provider = new FakeConversationTranscriptProvider();
    const caps = provider.getCapabilities();
    // recording_dependency is a PER-PROVIDER declaration; the fake declares
    // `unknown` — B3 asserts nothing about any real provider (directive §30.20).
    expect(caps.recording_dependency).toBe('unknown');
    expect(caps.full_post_conversation_transcript).toBe(true);
    // Live streaming is declared but never implemented in B3.
    expect(caps.live_transcript_stream).toBe(false);
  });

  it('acquisition result carries an OPAQUE artifact handle, never a transcript body', async () => {
    const provider = new FakeConversationTranscriptProvider({ mode: 'acquired' });
    const outcome = await provider.acquireTranscript({
      tenant_id: 't',
      provider_key: FAKE_TRANSCRIPT_PROVIDER_KEY,
      provider_transcript_id: 'pt-1',
    });
    expect(outcome.kind).toBe('acquired');
    if (outcome.kind !== 'acquired') return;
    const r = outcome.result;
    // A ref + hash — never a `body`/`text`/`utterances`/`content` field.
    expect(typeof r.source_artifact_ref).toBe('string');
    expect(r.source_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r).not.toHaveProperty('body');
    expect(r).not.toHaveProperty('text');
    expect(r).not.toHaveProperty('utterances');
    expect(r).not.toHaveProperty('content');
  });

  it('retryable and terminal failures are distinguishable via a taxonomy code (no raw text)', async () => {
    const retry = await new FakeConversationTranscriptProvider({ mode: 'retryable' })
      .acquireTranscript({ tenant_id: 't', provider_key: 'fake_transcript', provider_transcript_id: 'x' });
    const term = await new FakeConversationTranscriptProvider({ mode: 'terminal' })
      .acquireTranscript({ tenant_id: 't', provider_key: 'fake_transcript', provider_transcript_id: 'x' });
    expect(retry.kind).toBe('retryable_failure');
    expect(term.kind).toBe('terminal_failure');
  });

  it('fail-closed authorization: only explicit proof authorizes acquisition', () => {
    expect(isTranscriptionAuthorized(undefined)).toBe(false);
    expect(isTranscriptionAuthorized({ transcription_authorized: false })).toBe(false);
    expect(isTranscriptionAuthorized({ transcription_authorized: true })).toBe(true);
  });

  it('provider-neutrality: NO Zoom/Teams/Graph vendor tokens leak into the port or domain', () => {
    // Static source scan of the provider-neutral surfaces (adapter fakes and
    // this test file are excluded by construction; the fake carries no vendor
    // vocabulary). Directive §5/§30.17.
    const files = [
      'lib/provider/conversation-transcript-provider.port.ts',
      'lib/provider/conversation-transcript-provider.registry.ts',
      'lib/conversation-transcript.service.ts',
      'lib/conversation-transcript.repository.ts',
      'lib/domain/transcript-enums.ts',
      'lib/domain/transcript-state-machine.ts',
      'index.ts',
    ];
    const banned = /\b(zoom|teams|msgraph|rtms)\b/i;
    for (const f of files) {
      const text = readFileSync(resolve(LIB_SRC, f), 'utf8');
      expect(text, `${f} must not name a provider vendor`).not.toMatch(banned);
    }
  });
});
