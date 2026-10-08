import { ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, it, expect } from 'vitest';

import { PublishEngagementPolicyRequestDto } from '../engagement/dto/engagement.dto.js';

// Regression guard — the engagement publish DTO is driven by the SAME global
// ValidationPipe main.ts installs (whitelist + forbidNonWhitelisted + transform).
//
// The requirement array is a `channel`-discriminated union. A prior
// `@Type(() => Object)` mapping deserialized each element to a bare Object with
// NO class-validator metadata, so forbidNonWhitelisted rejected EVERY requirement
// property ("property channel should not exist", etc.) with HTTP 400 — every real
// publish (any non-empty requirements array) failed. The pre-existing controller
// spec used `requirements: []` and called the controller directly, bypassing the
// pipe, so it never caught this. This spec drives the real pipe with a NON-EMPTY
// requirements array (the normal case).
const PIPE = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const META: ArgumentMetadata = {
  type: 'body',
  metatype: PublishEngagementPolicyRequestDto,
};

describe('PublishEngagementPolicyRequestDto under the global ValidationPipe', () => {
  it('accepts an email requirement (the failing publish payload)', async () => {
    const body = {
      scope: 'CLIENT',
      scope_ref: '80c1f20d-a1cd-442f-b9ae-6857fa5a47ef',
      version: '1',
      schema_version: 1,
      requirements: [{ channel: 'email', required: true, condition: 'recorded_evidence' }],
      enforcement_mode: 'ENFORCING',
    };

    const out = (await PIPE.transform(body, META)) as PublishEngagementPolicyRequestDto;

    expect(out.requirements).toHaveLength(1);
    expect(out.requirements[0]).toMatchObject({
      channel: 'email',
      required: true,
      condition: 'recorded_evidence',
    });
  });

  it('accepts a voice requirement with minimum_strength', async () => {
    const body = {
      scope: 'TENANT',
      version: '2',
      schema_version: 1,
      requirements: [
        {
          channel: 'voice',
          required: true,
          condition: 'two_way_conversation',
          minimum_strength: 'RECRUITER_ATTESTED',
        },
      ],
    };

    const out = (await PIPE.transform(body, META)) as PublishEngagementPolicyRequestDto;

    expect(out.requirements[0]).toMatchObject({
      channel: 'voice',
      minimum_strength: 'RECRUITER_ATTESTED',
    });
  });

  it('still rejects a genuinely unknown property inside a requirement', async () => {
    const body = {
      scope: 'CLIENT',
      scope_ref: '80c1f20d-a1cd-442f-b9ae-6857fa5a47ef',
      version: '1',
      schema_version: 1,
      requirements: [
        { channel: 'email', required: true, condition: 'recorded_evidence', smuggled: 'x' },
      ],
    };

    await expect(PIPE.transform(body, META)).rejects.toMatchObject({
      response: { message: expect.arrayContaining([expect.stringContaining('smuggled')]) },
    });
  });

  it('still rejects an unsupported condition for the channel', async () => {
    const body = {
      scope: 'CLIENT',
      scope_ref: '80c1f20d-a1cd-442f-b9ae-6857fa5a47ef',
      version: '1',
      schema_version: 1,
      requirements: [{ channel: 'email', required: true, condition: 'two_way_conversation' }],
    };

    await expect(PIPE.transform(body, META)).rejects.toBeDefined();
  });
});
