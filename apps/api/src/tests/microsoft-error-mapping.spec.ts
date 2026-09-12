import { describe, expect, it, vi } from 'vitest';
import { MicrosoftReauthRequiredError } from '@aramo/microsoft-graph';

import { MicrosoftAuthorizationController } from '../microsoft/microsoft-authorization.controller.js';
import { MicrosoftProviderNotConfiguredError } from '../microsoft/microsoft-provider-not-configured.error.js';

// COMM-C2B Fix — the controller's catch-all used to map EVERY unexpected error
// (including a Secrets Manager AccessDeniedException while saving the client
// secret) to a misleading 409 MICROSOFT_PROVIDER_NOT_CONFIGURED with no log —
// which is why a prod IAM gap surfaced only as "Could not save". These prove the
// corrected mapping: only a genuine no-connection is 409; unexpected/infra
// failures surface as 500 INTERNAL_ERROR (and are logged).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const AUTH = { tenant_id: 't1', sub: 'u1', scopes: [] } as any;

function makeController(over: {
  configure?: ReturnType<typeof vi.fn>;
  email?: ReturnType<typeof vi.fn>;
} = {}): MicrosoftAuthorizationController {
  const orchestrator = { configureConnection: over.configure ?? vi.fn() };
  const email = { sendRecruiterEmail: over.email ?? vi.fn() };
  const meeting = { createRecruiterMeeting: vi.fn() };
  return new MicrosoftAuthorizationController(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    orchestrator as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    email as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meeting as any,
  );
}

describe('MicrosoftAuthorizationController error mapping', () => {
  it('an unexpected/infra failure (e.g. Secrets Manager AccessDenied) surfaces as 500 INTERNAL_ERROR — NOT a masked 409', async () => {
    const awsErr = Object.assign(
      new Error(
        'User: arn:aws:iam::…:user/aramo-api-prod is not authorized to perform: secretsmanager:PutSecretValue',
      ),
      { name: 'AccessDeniedException' },
    );
    const ctl = makeController({ configure: vi.fn().mockRejectedValue(awsErr) });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctl.configure(AUTH, { client_id: 'a', authority_tenant: 'b', client_secret: 's' } as any, 'rq-1'),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
  });

  it('a genuine no-connection maps to 409 MICROSOFT_PROVIDER_NOT_CONFIGURED', async () => {
    const ctl = makeController({
      email: vi.fn().mockRejectedValue(new MicrosoftProviderNotConfiguredError()),
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctl.sendEmail(AUTH, { to_email: 'x@y.z', subject: 's', body: 'b' } as any, 'rq-2'),
    ).rejects.toMatchObject({ code: 'MICROSOFT_PROVIDER_NOT_CONFIGURED', statusCode: 409 });
  });

  it('a reauthorization-required error still maps to 409 (regression guard)', async () => {
    const ctl = makeController({
      email: vi.fn().mockRejectedValue(new MicrosoftReauthRequiredError()),
    });
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctl.sendEmail(AUTH, { to_email: 'x@y.z', subject: 's', body: 'b' } as any, 'rq-3'),
    ).rejects.toMatchObject({ code: 'MICROSOFT_REAUTHORIZATION_REQUIRED', statusCode: 409 });
  });
});
