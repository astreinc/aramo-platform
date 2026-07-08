// TR-3 B2 (§3.1) — the verification email renderer.
//
// A pure renderer on the invite-emails conventions (libs/identity's
// invite-emails.ts): a minimal confident-blue HTML shell + a plaintext
// fallback, returning the pre-rendered { subject, html, text } the MailerPort
// expects (the port does NOT template). NO marketing content — one plain
// confirm link. The FROM address is fixed adapter config in the mailer
// (support@aramo.ai / "Aramo Support"), never set here.

const BRAND_BLUE = '#1d4ed8';
const INK = '#0f172a';
const MUTED = '#475569';

// Minimal HTML-escape for interpolated free text (the token lives inside an
// href we build, not in prose). Mirrors invite-emails.esc.
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

// The confirm-link base. Points at the ats-web PUBLIC confirm page (which POSTs
// the token to the public confirm endpoint). Env-configured per the
// INVITE_ACCEPT_URL precedent, with a dev-safe localhost default so a local run
// renders a clickable link with no extra setup.
export function loadVerificationLinkConfig(): { confirmBaseUrl: string } {
  const confirmBaseUrl =
    process.env['EMAIL_VERIFICATION_CONFIRM_URL'] ??
    'http://localhost/email-verifications/confirm';
  return { confirmBaseUrl };
}

// Append the raw token to the confirm-page base (query param — the page reads
// ?token= exactly as the invitation-accept page does).
export function buildConfirmUrl(base: string, rawToken: string): string {
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(rawToken)}`;
}

// Sent when a recruiter requests verification of a stored email. Carries the
// confirm link (raw token embedded). One action, no marketing.
export function renderVerificationEmail(args: {
  tenantLabel: string;
  confirmUrl: string;
}): RenderedEmail {
  const subject = `Confirm your email for ${args.tenantLabel} on Aramo`;
  const html = shell(
    `<p style="margin:0 0 12px;"><strong>${esc(
      args.tenantLabel,
    )}</strong> asked us to confirm that this email address reaches you.</p>` +
      `<p style="margin:0;">Click below to confirm. The link is good for 72 hours.</p>` +
      button(args.confirmUrl, 'Confirm this email') +
      `<p style="margin:0;color:${MUTED};font-size:13px;">Or paste this link into your browser:<br/><span style="word-break:break-all;">${esc(
        args.confirmUrl,
      )}</span></p>`,
  );
  const text = [
    `${args.tenantLabel} asked us to confirm that this email address reaches you.`,
    ``,
    `Confirm this email (the link is good for 72 hours):`,
    args.confirmUrl,
    ``,
    `If you weren't expecting this email you can safely ignore it.`,
  ].join('\n');
  return { subject, html, text };
}
