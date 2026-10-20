import { Inject, Injectable } from '@nestjs/common';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import { type SigningNotification, type SigningNotificationPort, type SigningNotificationResult } from '@aramo/sign';

// DOC-3 §298 / Aramo Sign launch — binds the E-Sign SigningNotificationPort to the
// generic MailerPort (SES / stub by env). E-Sign imports no provider SDK.
//
// Content is rendered here per notification kind and audience. Every dynamic value
// is HTML-escaped; links are emitted only for http(s) URLs. Links carrying a raw
// token (signing_url, download_url) go into the body but are NEVER logged.
// `delivered` reflects what the mailer actually did: a provider failure throws,
// and the caller records it as FAILED.

const BRAND = 'Aramo Sign';

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(u: string | undefined): string | null {
  if (u === undefined) return null;
  return /^https?:\/\//i.test(u) ? u : null;
}

interface Rendered {
  subject: string;
  lines: string[];
  action?: { label: string; url: string };
  footnote?: string;
}

export function renderSigningNotification(n: SigningNotification): Rendered {
  const doc = n.envelope_subject;
  const sender = (n.audience ?? 'SIGNER') === 'SENDER';
  switch (n.kind) {
    case 'SIGNATURE_REQUEST': {
      const url = safeUrl(n.signing_url);
      return {
        subject: `Please sign: ${doc}`,
        lines: [`You've been asked to review and sign "${doc}".`, 'No account is needed — open the document from the button below.'],
        action: url ? { label: 'Review & sign', url } : undefined,
        footnote: 'This signing link is personal to you. Do not forward this email.',
      };
    }
    case 'SIGNATURE_REMINDER': {
      const url = safeUrl(n.signing_url);
      return {
        subject: `Reminder: please sign ${doc}`,
        lines: [`"${doc}" is still waiting for your signature.`],
        action: url ? { label: 'Review & sign', url } : undefined,
        footnote: 'Earlier signing links for this document no longer work — use this one.',
      };
    }
    case 'SIGNATURE_COMPLETED': {
      if (sender) {
        const url = safeUrl(n.console_url);
        return {
          subject: `Completed: ${doc}`,
          lines: [`Everyone has signed "${doc}".`, 'The signed document and its certificate of completion are ready in Aramo Sign.'],
          action: url ? { label: 'View in Aramo Sign', url } : undefined,
        };
      }
      const url = safeUrl(n.download_url);
      return {
        subject: `Completed: ${doc}`,
        lines: [`Everyone has signed "${doc}".`, url ? 'Download your signed copy and its certificate of completion below.' : 'The sender has the signed copy.'],
        action: url ? { label: 'Download signed copy', url } : undefined,
        footnote: url ? 'This download link is personal to you and expires after 30 days.' : undefined,
      };
    }
    case 'SIGNATURE_DECLINED': {
      if (sender) {
        const url = safeUrl(n.console_url);
        return {
          subject: `Declined: ${doc}`,
          lines: [`A signer declined to sign "${doc}".`, ...(n.reason ? [`Reason given — ${n.reason}`] : []), 'The envelope has ended; no one can sign it now.'],
          action: url ? { label: 'View in Aramo Sign', url } : undefined,
        };
      }
      return {
        subject: `No longer needed: ${doc}`,
        lines: [`Another signer declined "${doc}", so it can no longer be signed.`, "You don't need to do anything."],
      };
    }
    case 'SIGNATURE_VOIDED':
      return {
        subject: `Withdrawn: ${doc}`,
        lines: [`The sender withdrew the request to sign "${doc}".`, ...(n.reason ? [`Reason given — ${n.reason}`] : []), "Your signing link no longer works. You don't need to do anything."],
      };
    case 'SIGNER_SIGNED': {
      const url = safeUrl(n.console_url);
      const who = n.signer_name ?? 'A signer';
      const progress = n.signed_count !== undefined && n.signer_count !== undefined ? ` (${n.signed_count} of ${n.signer_count})` : '';
      return {
        subject: `${who} signed ${doc}${progress}`,
        lines: [
          `${who} signed "${doc}"${progress}.`,
          n.next_signer_name ? `${n.next_signer_name} is next and has been sent the document.` : 'The others can still sign.',
        ],
        action: url ? { label: 'View in Aramo Sign', url } : undefined,
      };
    }
    case 'SIGNATURE_EXPIRED': {
      if (sender) {
        const url = safeUrl(n.console_url);
        return {
          subject: `Expired: ${doc}`,
          lines: [`"${doc}" expired before everyone signed.`, 'You can send it again from Aramo Sign.'],
          action: url ? { label: 'View in Aramo Sign', url } : undefined,
        };
      }
      return {
        subject: `Expired: ${doc}`,
        lines: [`The signing window for "${doc}" has closed.`, 'If you still need to sign, ask the sender to send it again.'],
      };
    }
  }
}

@Injectable()
export class MailerSigningNotificationAdapter implements SigningNotificationPort {
  constructor(@Inject(MAILER_PORT) private readonly mailer: MailerPort) {}

  async notify(input: SigningNotification): Promise<SigningNotificationResult> {
    const r = renderSigningNotification(input);
    const html = [
      `<p>Hello ${esc(input.to_name)},</p>`,
      ...r.lines.map((l) => `<p>${esc(l)}</p>`),
      r.action ? `<p><a href="${esc(r.action.url)}">${esc(r.action.label)}</a></p>` : '',
      r.footnote ? `<p style="color:#5c6770;font-size:13px">${esc(r.footnote)}</p>` : '',
      `<p style="color:#5c6770;font-size:13px">— ${BRAND}</p>`,
    ].join('');
    const text = [`Hello ${input.to_name},`, ...r.lines, r.action ? `${r.action.label}: ${r.action.url}` : '', r.footnote ?? '', `— ${BRAND}`]
      .filter((l) => l.length > 0)
      .join('\n\n');
    const sent = await this.mailer.send({ to: input.to_email, subject: r.subject, html, text });
    return { delivered: true, provider_message_id: sent.message_id };
  }
}
