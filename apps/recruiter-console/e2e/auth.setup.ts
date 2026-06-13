import { expect, test as setup } from '@playwright/test';

import { loginViaCognito } from './cognito-login';

// Auth setup — perform the REAL Cognito login ONCE and persist the genuine
// session (HttpOnly cookies) as storageState for the surface walk. The session
// is a real artifact: it must NEVER be committed (e2e/.auth/ is gitignored).

const AUTH_STATE = 'apps/recruiter-console/e2e/.auth/recruiter.json';

setup('authenticate via real Cognito session flow', async ({ page }) => {
  const username = process.env['RC_E2E_USERNAME'];
  const password = process.env['RC_E2E_PASSWORD'];
  if (
    username === undefined ||
    username === '' ||
    password === undefined ||
    password === ''
  ) {
    throw new Error(
      'RC_E2E_USERNAME and RC_E2E_PASSWORD must be set (dedicated test recruiter Cognito user). ' +
        'Provide them via env/secret — never commit them.',
    );
  }

  await loginViaCognito(page, {
    username,
    password,
    ...(process.env['RC_E2E_TOTP_SECRET'] !== undefined
      ? { totpSecret: process.env['RC_E2E_TOTP_SECRET'] }
      : {}),
  });

  // Prove a genuine authenticated session: the recruiter shell renders (the
  // rail brand is shell chrome that only mounts post-auth).
  await expect(page.getByText('Aramo · Recruiter')).toBeVisible({
    timeout: 20_000,
  });

  await page.context().storageState({ path: AUTH_STATE });
});
