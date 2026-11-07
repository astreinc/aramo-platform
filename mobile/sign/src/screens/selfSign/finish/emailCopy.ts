// M-A14 R-2 — "Email" on You're almost there: the device mail composer with the executed
// PDF attached and the subject prefilled (the document title). No server email-out. When
// no mail account is set up (isAvailableAsync false) it falls back to the share sheet.
// The PDFs are the same authorized executed copies Share and Save use (M-A13 #7:
// loadCompletedPdfs → GET /v1/sign/sender/envelopes/{id}/executed); each file is written
// to the app's cache for the composer and deleted when it closes.
import {
  loadCompletedPdfs,
  pdfFilename,
  refusal,
  shareCompleted,
  SHARE_NOT_ALLOWED,
  SHARE_NOT_READY,
  type ShareDeps,
  type ShareOutcome,
  type ShareTarget,
} from '../../../features/share/shareCompleted';

export interface MailComposerPort {
  available(): Promise<boolean>;
  /** Resolves when the composer closes; 'cancelled' when the user backed out. */
  compose(options: {
    readonly subject: string;
    readonly attachments: readonly string[];
  }): Promise<'sent' | 'saved' | 'cancelled' | 'undetermined'>;
}

export interface EmailDeps extends ShareDeps {
  readonly mail: MailComposerPort;
}

export type EmailOutcome =
  | { readonly kind: 'emailed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'shared'; readonly files: number }
  | { readonly kind: 'refused'; readonly message: string };

export async function emailCompleted(
  target: ShareTarget | null,
  deps: EmailDeps,
): Promise<EmailOutcome> {
  if (!target) return { kind: 'refused', message: SHARE_NOT_ALLOWED };
  let canMail = false;
  try {
    canMail = await deps.mail.available();
  } catch {
    canMail = false;
  }
  if (!canMail) {
    const r: ShareOutcome = await shareCompleted(target, deps);
    return r;
  }
  let pdfs;
  try {
    pdfs = await loadCompletedPdfs(target, deps);
  } catch (e) {
    return refusal(e);
  }
  if (!pdfs || pdfs.length === 0) return { kind: 'refused', message: SHARE_NOT_READY };
  const uris: string[] = [];
  try {
    for (const [i, pdf] of pdfs.entries()) {
      uris.push(await deps.files.writeTemp(pdfFilename(pdf.title, i), pdf.base64));
    }
    const status = await deps.mail.compose({ subject: target.subject, attachments: uris });
    return status === 'cancelled' ? { kind: 'cancelled' } : { kind: 'emailed' };
  } catch (e) {
    return refusal(e);
  } finally {
    for (const uri of uris) deps.files.remove(uri);
  }
}
