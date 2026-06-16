import { createHmac } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

// Performs the REAL Cognito hosted-UI login. Starting at the app root while
// unauthenticated, the FE redirects to /auth/recruiter/login → auth-service
// 302 → the Cognito hosted UI (oauth2/authorize). We fill the form, optionally
// answer a TOTP challenge, and let Cognito redirect back to the app origin with
// a genuine HttpOnly session cookie set by auth-service.
//
// Hosted-UI selectors: Cognito ships two UIs (the classic hosted UI and the
// newer "managed login"). The locators below try the common shapes of both; if
// the pool uses a customized UI, adjust the selectors on first live run (this
// is the one place that may need tuning — flagged intentionally).

interface LoginOpts {
  readonly username: string;
  readonly password: string;
  /** Optional base32 TOTP seed; omit when MFA is disabled for the test user. */
  readonly totpSecret?: string;
}

export async function loginViaCognito(page: Page, opts: LoginOpts): Promise<void> {
  await page.goto('/');

  // Land on the Cognito hosted UI (or a login form).
  await page.waitForURL(/amazoncognito\.com|\/oauth2\/|\/login/i, {
    timeout: 30_000,
  });

  const username = page
    .locator(
      'input[name="username"], input[type="email"], input[autocomplete="username"], #signInFormUsername',
    )
    .first();
  await expect(username).toBeVisible({ timeout: 20_000 });
  await username.fill(opts.username);

  const password = page
    .locator('input[name="password"], input[type="password"], #signInFormPassword')
    .first();
  await password.fill(opts.password);

  await page
    .locator(
      'input[name="signInSubmitButton"], button[type="submit"], input[type="submit"]',
    )
    .first()
    .click();

  // Optional software-token MFA.
  if (opts.totpSecret !== undefined && opts.totpSecret !== '') {
    const codeField = page
      .locator(
        'input[name="confirmationCode"], input[autocomplete="one-time-code"], input[name*="code" i]',
      )
      .first();
    await codeField.waitFor({ state: 'visible', timeout: 15_000 });
    await codeField.fill(totp(opts.totpSecret));
    await page
      .locator('button[type="submit"], input[type="submit"]')
      .first()
      .click();
  }

  // Back on the app origin with a real session.
  await page.waitForURL(/localhost:4201|127\.0\.0\.1:4201/, { timeout: 30_000 });
}

// --- minimal RFC-6238 TOTP (no dependency) ---------------------------------
// Only used when a TOTP seed is supplied. SHA-1, 6 digits, 30s step.
function totp(base32Secret: string): string {
  const key = base32Decode(base32Secret.replace(/\s|=/g, '').toUpperCase());
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, '0');
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}
