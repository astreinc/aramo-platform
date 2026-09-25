import { useEffect, useState } from 'react';
import { Button } from '@aramo/fe-foundation';

import { Icons } from '../ui';

// Shared résumé preview panel used by BOTH Add-Talent (Create) and the full
// profile Edit. Renders the résumé inline so the recruiter can validate the
// form against the source. Two sources:
//   • `file` — an in-memory File (Create, or a just-replaced résumé).
//   • `src`  — a presigned GET URL (Edit: the résumé already stored on S3).
// PDFs render in an <iframe>. DOCX is converted to HTML in the browser via a
// lazy-loaded mammoth (no backend), so Word résumés preview too. Anything else
// shows a note. An Expand button opens a full-screen overlay.
type DocxState = 'idle' | 'loading' | 'ready' | 'error';

export function ResumePreview(props: {
  readonly file?: File;
  readonly src?: string | null;
  readonly fileName: string;
  readonly mime?: string | null;
  // Optional slot rendered in the header row (e.g. a Replace control).
  readonly action?: React.ReactNode;
}) {
  const { file, src, fileName, mime, action } = props;
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [docxState, setDocxState] = useState<DocxState>('idle');

  const lower = fileName.toLowerCase();
  const isPdf = mime === 'application/pdf' || lower.endsWith('.pdf');
  const isDocx =
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lower.endsWith('.docx');

  // PDF object URL (only for an in-memory File; a presigned src is used directly).
  useEffect(() => {
    if (file === undefined || !isPdf) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isPdf]);

  // DOCX → HTML, in the browser (lazy mammoth). Bytes come from the File
  // directly, or by fetching the presigned URL (S3 CORS already allows the
  // browser — the upload uses a presigned PUT from here).
  useEffect(() => {
    if (!isDocx) return;
    let cancelled = false;
    setDocxState('loading');
    setDocxHtml(null);
    const bytes: Promise<ArrayBuffer> =
      file !== undefined
        ? file.arrayBuffer()
        : src != null
          ? fetch(src).then((r) => r.arrayBuffer())
          : Promise.reject(new Error('no source'));
    bytes
      .then(async (arrayBuffer) => {
        const mammoth = (await import('mammoth')) as unknown as {
          convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
        };
        const { value } = await mammoth.convertToHtml({ arrayBuffer });
        if (!cancelled) {
          setDocxHtml(value);
          setDocxState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setDocxState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [isDocx, file, src]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const pdfUrl = file !== undefined ? objectUrl : (src ?? null);
  const ext = lower.split('.').pop() ?? 'file';
  const canExpand = (isPdf && pdfUrl !== null) || (isDocx && docxState === 'ready');

  const body = ((): React.ReactNode => {
    if (isPdf && pdfUrl !== null) {
      return <iframe className="rc-rpreview__frame" title="Résumé preview" src={pdfUrl} />;
    }
    if (isDocx) {
      if (docxState === 'ready' && docxHtml !== null) {
        return (
          <div
            className="rc-rpreview__docx"
            // mammoth emits structural HTML (headings/paragraphs/tables/lists);
            // no scripts. Source is the recruiter's own uploaded résumé.
            dangerouslySetInnerHTML={{ __html: docxHtml }}
          />
        );
      }
      if (docxState === 'error') {
        return (
          <p className="rc-secnote">
            We couldn’t render this .docx inline — the attached résumé is saved
            with the record and can be opened from Documents.
          </p>
        );
      }
      return <p className="rc-secnote">Rendering résumé…</p>;
    }
    return (
      <p className="rc-secnote">
        Inline preview isn’t available for a .{ext} file — the attached résumé is
        saved with the record and can be opened from Documents.
      </p>
    );
  })();

  return (
    <section className="rc-sidecard rc-rpreview" aria-label="Résumé preview">
      <div className="rc-rpreview__hdrow">
        <h3 className="rc-sidecard__h">
          <Icons.IconFile />
          Résumé preview
        </h3>
        <div className="rc-rpreview__hdactions">
          {action ?? null}
          {canExpand ? (
            <Button unstyled
              type="button"
              className="rc-rpreview__expand"
              onClick={() => setExpanded(true)}
            >
              Expand
            </Button>
          ) : null}
        </div>
      </div>
      {body}
      {expanded && canExpand ? (
        <div
          className="rc-rpreview__overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Résumé full preview"
        >
          <div className="rc-rpreview__ovbar">
            <span className="rc-rpreview__ovtitle">{fileName}</span>
            <Button unstyled
              type="button"
              className="rc-rpreview__ovclose"
              onClick={() => setExpanded(false)}
            >
              Close
            </Button>
          </div>
          {isPdf && pdfUrl !== null ? (
            <iframe className="rc-rpreview__ovframe" title="Résumé full preview" src={pdfUrl} />
          ) : (
            <div
              className="rc-rpreview__ovdocx"
              dangerouslySetInnerHTML={{ __html: docxHtml ?? '' }}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
