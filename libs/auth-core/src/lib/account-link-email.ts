// Apple Go-Live Amendment A1 (LOCKED) L-4 (b) / L-5 — the account-linking emails:
// the one-time code, and the security notice sent to the account email whenever a
// sign-in method is added or removed. Same shell as the portal sign-in email
// (portal-login-email.ts): a minimal HTML body plus a plaintext fallback. The
// copy is plain and names the provider (L-7). No link is embedded.

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  google: 'Google',
  microsoft: 'Microsoft',
  apple: 'Apple',
};

export function providerLabel(idp: string): string {
  return PROVIDER_LABEL[idp] ?? 'A sign-in provider';
}

function shell(heading: string, paragraphs: string[]): string {
  return [
    '<!doctype html>',
    '<html><body style="font-family:system-ui,Arial,sans-serif;color:#1a1a1a;">',
    `<h2>${heading}</h2>`,
    ...paragraphs.map((p) => `<p>${p}</p>`),
    '</body></html>',
  ].join('');
}

export function renderLinkCodeEmail(input: { code: string; idp: string }): { subject: string; html: string; text: string } {
  const provider = providerLabel(input.idp);
  const subject = 'Your Aramo verification code';
  const intro = `Use this code to connect ${provider} to your Aramo account. It expires in 10 minutes.`;
  const ignore = "If you didn't ask for this, you can ignore this email. Nothing changes until the code is entered.";
  const html = shell('Confirm it’s you', [
    intro,
    `<strong style="font-size:24px;letter-spacing:4px;">${input.code}</strong>`,
    ignore,
  ]);
  const text = ['Confirm it’s you', '', intro, '', input.code, '', ignore].join('\n');
  return { subject, html, text };
}

export function renderSignInMethodNoticeEmail(input: { idp: string; change: 'added' | 'removed' }): {
  subject: string;
  html: string;
  text: string;
} {
  const provider = providerLabel(input.idp);
  const subject = input.change === 'added' ? `${provider} sign-in added to your Aramo account` : `${provider} sign-in removed from your Aramo account`;
  const what =
    input.change === 'added'
      ? `${provider} was added as a sign-in method to your Aramo account.`
      : `${provider} was removed as a sign-in method from your Aramo account.`;
  const ifNot =
    "If this wasn't you, sign in to Aramo, review Account → Sign-in methods, and contact support@aramo.ai.";
  const html = shell('Sign-in methods changed', [what, ifNot]);
  const text = ['Sign-in methods changed', '', what, '', ifNot].join('\n');
  return { subject, html, text };
}
