// Portal P1 — the passwordless magic-link email renderer + link builder. Modeled
// on the TR-3 verification-emails renderer (apps/api/.../verification-emails.ts):
// a minimal branded HTML shell + plaintext fallback, one sign-in button. The
// @aramo/mailer port does NOT template — the caller supplies pre-rendered markup.
// The raw token is embedded in the link HERE — the only place it is exposed after
// mint. Origin secrecy holds by construction: the email names no tenant.

export function buildPortalLoginUrl(baseUrl: string, rawToken: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/auth/portal/consume?token=${encodeURIComponent(rawToken)}`;
}

export function renderPortalLoginEmail(input: { confirmUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = 'Your Aramo sign-in link';
  const html = [
    '<!doctype html>',
    '<html><body style="font-family:system-ui,Arial,sans-serif;color:#1a1a1a;">',
    '<h2>Sign in to Aramo</h2>',
    '<p>Click the button below to sign in. This link expires in 15 minutes and can be used once.</p>',
    `<p><a href="${input.confirmUrl}" style="display:inline-block;padding:12px 20px;background:#1f6feb;color:#fff;text-decoration:none;border-radius:6px;">Sign in</a></p>`,
    '<p>If you did not request this, you can safely ignore this email.</p>',
    '</body></html>',
  ].join('');
  const text = [
    'Sign in to Aramo',
    '',
    'Open this link to sign in (expires in 15 minutes, single use):',
    input.confirmUrl,
    '',
    'If you did not request this, you can safely ignore this email.',
  ].join('\n');
  return { subject, html, text };
}
