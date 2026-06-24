// Invite-S2 (Pattern-2) — §5 transactional email templates.
//
// Two pure renderers that return the pre-rendered { subject, html, text } the
// S1 MailerPort expects (the port does NOT template — rendering is the
// caller's concern). Deliberately minimal: a small branded (confident-blue)
// HTML shell + a plaintext fallback, no template engine. The FROM address is
// fixed adapter config in the mailer (support@aramo.ai / "Aramo Support") —
// never set here.

const BRAND_BLUE = '#1d4ed8';
const INK = '#0f172a';
const MUTED = '#475569';

// Minimal HTML-escape for interpolated tenant/label text (the token already
// lives in an href we build, not in free text). Keeps a stray '&' / '<' in a
// tenant display_name from breaking the markup.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shell(bodyHtml: string): string {
  return [
    `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">`,
    `<tr><td align="center">`,
    `<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">`,
    `<tr><td style="background:${BRAND_BLUE};padding:20px 28px;color:#ffffff;font-size:18px;font-weight:600;">Aramo</td></tr>`,
    `<tr><td style="padding:28px;color:${INK};font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>`,
    `<tr><td style="padding:0 28px 28px;color:${MUTED};font-size:12px;line-height:1.5;">If you weren't expecting this email you can safely ignore it.</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join('');
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:${BRAND_BLUE};border-radius:8px;"><a href="${esc(href)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">${esc(label)}</a></td></tr></table>`;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

// Invite/sign-in link bases. The invite link points at the FE acceptance
// page (which POSTs the token to the public accept endpoint); the
// confirmation email points at the sign-in page. Env-configured (box values
// in .env.prod.example), with a dev-safe localhost default so a local run
// renders a clickable link without extra setup.
export function loadInviteLinkConfig(): {
  acceptBaseUrl: string;
  signInUrl: string;
} {
  const acceptBaseUrl =
    process.env['INVITE_ACCEPT_URL'] ?? 'http://localhost/invitations/accept';
  const signInUrl = process.env['INVITE_SIGNIN_URL'] ?? 'http://localhost/login';
  return { acceptBaseUrl, signInUrl };
}

export function buildAcceptUrl(base: string, rawToken: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(rawToken)}`;
}

// Sent at INVITED. Carries the accept link (raw token embedded).
export function renderInviteEmail(args: {
  tenantLabel: string;
  acceptUrl: string;
}): RenderedEmail {
  const subject = `You've been invited to ${args.tenantLabel} on Aramo`;
  const html = shell(
    `<p style="margin:0 0 12px;">You've been invited to join <strong>${esc(
      args.tenantLabel,
    )}</strong> on Aramo.</p>` +
      `<p style="margin:0;">Click below to accept your invitation. After accepting, you can sign in whenever you're ready.</p>` +
      button(args.acceptUrl, 'Accept invitation') +
      `<p style="margin:0;color:${MUTED};font-size:13px;">Or paste this link into your browser:<br/><span style="word-break:break-all;">${esc(
        args.acceptUrl,
      )}</span></p>`,
  );
  const text = [
    `You've been invited to join ${args.tenantLabel} on Aramo.`,
    ``,
    `Accept your invitation:`,
    args.acceptUrl,
    ``,
    `After accepting, you can sign in whenever you're ready.`,
    `If you weren't expecting this email you can safely ignore it.`,
  ].join('\n');
  return { subject, html, text };
}

// Sent at ACCEPTED. No token — just a sign-in pointer.
export function renderAcceptanceEmail(args: {
  tenantLabel: string;
  signInUrl: string;
}): RenderedEmail {
  const subject = `You're confirmed for ${args.tenantLabel} on Aramo`;
  const html = shell(
    `<p style="margin:0 0 12px;">Your invitation to <strong>${esc(
      args.tenantLabel,
    )}</strong> is confirmed.</p>` +
      `<p style="margin:0;">Sign in whenever you're ready — your access is active.</p>` +
      button(args.signInUrl, 'Sign in to Aramo') +
      `<p style="margin:0;color:${MUTED};font-size:13px;">Or paste this link into your browser:<br/><span style="word-break:break-all;">${esc(
        args.signInUrl,
      )}</span></p>`,
  );
  const text = [
    `Your invitation to ${args.tenantLabel} is confirmed.`,
    ``,
    `Sign in whenever you're ready:`,
    args.signInUrl,
  ].join('\n');
  return { subject, html, text };
}
