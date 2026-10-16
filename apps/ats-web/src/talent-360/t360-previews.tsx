// Talent 360 — on-demand previews (from PR #946, carried into the redesign):
// the full sent email behind an activity row and a read-only document preview.
// Both load through the authenticated API when opened — never inlined in the
// Talent 360 read, never a raw storage link.
import { useEffect, useState } from 'react';
import { Dialog, DialogClose, InlineAlert } from '@aramo/fe-foundation';

import { Button, LoadingState, safeErrorMessage } from '../ui';

import { getTalent360CommunicationPreview, getTalent360DocumentContent } from './talent-360-api';
import type { CommunicationPreviewView, TalentDocumentContentView } from './talent-360-types';

// The full sent email behind a Recent-activity row, loaded on demand (never
// inlined in the Talent 360 read). Closes on the X, a click outside, or Escape.
export function EmailPreviewDialog({
  talentId,
  interactionId,
  onClose,
}: {
  talentId: string;
  interactionId: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState<CommunicationPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTalent360CommunicationPreview(talentId, interactionId)
      .then((v) => {
        if (!cancelled) setEmail(v);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(safeErrorMessage(e, 'This email could not be loaded.'));
      });
    return () => {
      cancelled = true;
    };
  }, [talentId, interactionId]);

  const subject = email === null ? 'Email' : (email.subject ?? '(no subject)');
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={<span className="t360-email-title">{subject}</span>}
      size="lg"
    >
      <DialogClose asChild>
        <Button unstyled type="button" className="t360-email-close" aria-label="Close email preview">
          ×
        </Button>
      </DialogClose>
      {error !== null ? (
        <InlineAlert variant="error">{error}</InlineAlert>
      ) : email === null ? (
        <LoadingState label="Loading email…" />
      ) : (
        <div className="t360-email">
          <dl className="t360-email-meta">
            <dt>From</dt>
            <dd>
              {email.sender_label !== null ? `${email.sender_label} <${email.from_address}>` : email.from_address}
            </dd>
            <dt>To</dt>
            <dd>{email.to_address}</dd>
            <dt>Sent</dt>
            <dd>
              {new Date(email.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </dd>
            {email.requisition_label !== null && (
              <>
                <dt>Requisition</dt>
                <dd>{email.requisition_label}</dd>
              </>
            )}
          </dl>
          {email.body !== null && email.body.trim().length > 0 ? (
            <div className="t360-email-body">{email.body}</div>
          ) : (
            <div className="t360-empty">The message body was not recorded for this email.</div>
          )}
        </div>
      )}
    </Dialog>
  );
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type DocPreviewBody =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'pdf'; url: string }
  | { kind: 'image'; url: string }
  | { kind: 'docx'; html: string }
  | { kind: 'download' };

// Read-only preview of a Talent document (PO ruling: nothing is recorded). The
// file is loaded on open through the authenticated API (never a raw S3 link): PDF
// and images render inline, DOCX is converted in the browser (the ResumePreview
// mammoth path), anything else offers Download. X, click outside or Escape close.
export function DocumentPreviewDialog({
  talentId,
  documentId,
  title,
  onClose,
}: {
  talentId: string;
  documentId: string;
  title: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<TalentDocumentContentView | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [body, setBody] = useState<DocPreviewBody>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    getTalent360DocumentContent(talentId, documentId)
      .then(async (doc) => {
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(doc.content_base64), (c) => c.charCodeAt(0));
        const mime = doc.mime_type === '' ? 'application/octet-stream' : doc.mime_type;
        url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setFile(doc);
        setBlobUrl(url);
        const lower = doc.file_name.toLowerCase();
        if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
          setBody({ kind: 'pdf', url });
        } else if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
          setBody({ kind: 'image', url });
        } else if (mime === DOCX_MIME || lower.endsWith('.docx')) {
          const mammoth = (await import('mammoth')) as unknown as {
            convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
          };
          const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
          if (!cancelled) setBody({ kind: 'docx', html: value });
        } else {
          setBody({ kind: 'download' });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setBody({ kind: 'error', message: safeErrorMessage(e, 'This document could not be loaded.') });
      });
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [talentId, documentId]);

  const name = file?.file_name ?? title;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={<span className="t360-email-title">{name}</span>}
      size="xl"
    >
      <DialogClose asChild>
        <Button unstyled type="button" className="t360-email-close" aria-label="Close document preview">
          ×
        </Button>
      </DialogClose>
      <div className="t360-docpv">
        {body.kind === 'loading' && <LoadingState label="Loading document…" />}
        {body.kind === 'error' && <InlineAlert variant="error">{body.message}</InlineAlert>}
        {body.kind === 'pdf' && <iframe className="t360-docpv__frame" title={`Preview of ${name}`} src={body.url} />}
        {body.kind === 'image' && <img className="t360-docpv__img" src={body.url} alt={name} />}
        {body.kind === 'docx' && (
          <div className="t360-docpv__docx rc-rpreview__docx" dangerouslySetInnerHTML={{ __html: body.html }} />
        )}
        {body.kind === 'download' && (
          <div className="t360-empty">Inline preview isn’t available for this file type — download it to open.</div>
        )}
        {blobUrl !== null && (
          <div className="t360-docpv__bar">
            <a className="t360-link" href={blobUrl} download={name}>
              Download
            </a>
          </div>
        )}
      </div>
    </Dialog>
  );
}
