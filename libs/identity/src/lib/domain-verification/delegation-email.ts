// Domain-Enforcement P3 §5 — the email sent to the IT / domain administrator a
// tenant owner or admin assigned the domain verification to. Pure renderer
// returning the pre-rendered { subject, html, text } the MailerPort expects (the
// invite-emails.ts shape; its private shell is mirrored here, not imported).

const BRAND_BLUE = '#1d4ed8';
const INK = '#0f172a';
const MUTED = '#475569';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderedDelegationEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderDelegationEmail(args: {
  organizationLabel: string;
  domain: string;
  link: string;
  expiresAt: Date;
}): RenderedDelegationEmail {
  const org = args.organizationLabel;
  const expires = args.expiresAt.toUTCString();
  const subject = `Please verify ${args.domain} for ${org} on Aramo`;
  const body =
    `<p style="margin:0 0 12px;"><strong>${esc(org)}</strong> asked you to verify that it controls the domain <strong>${esc(args.domain)}</strong> on Aramo.</p>` +
    `<p style="margin:0 0 12px;">The link below shows one DNS TXT record to add at the domain's DNS provider, and a button to check it once it is published. It gives you no other access to Aramo.</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td style="background:${BRAND_BLUE};border-radius:8px;"><a href="${esc(args.link)}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">Open the DNS record</a></td></tr></table>` +
    `<p style="margin:0;color:${MUTED};font-size:13px;">This link expires on ${esc(expires)}. Or paste it into your browser:<br/><span style="word-break:break-all;">${esc(args.link)}</span></p>`;
  const html = [
    `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">`,
    `<tr><td align="center">`,
    `<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">`,
    `<tr><td style="background:${BRAND_BLUE};padding:20px 28px;color:#ffffff;font-size:18px;font-weight:600;">Aramo</td></tr>`,
    `<tr><td style="padding:28px;color:${INK};font-size:15px;line-height:1.6;">${body}</td></tr>`,
    `<tr><td style="padding:0 28px 28px;color:${MUTED};font-size:12px;line-height:1.5;">If you weren't expecting this email you can safely ignore it.</td></tr>`,
    `</table></td></tr></table></body></html>`,
  ].join('');
  const text = [
    `${org} asked you to verify that it controls the domain ${args.domain} on Aramo.`,
    ``,
    `Open this link to see the DNS TXT record to publish and to check it:`,
    args.link,
    ``,
    `The link gives you no other access to Aramo and expires on ${expires}.`,
    `If you weren't expecting this email you can safely ignore it.`,
  ].join('\n');
  return { subject, html, text };
}
