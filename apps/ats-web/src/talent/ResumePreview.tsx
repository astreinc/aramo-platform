import { useEffect, useState } from 'react';

import { Icons } from '../ui';

// Shared résumé preview panel used by BOTH Add-Talent (Create) and the full
// profile Edit. Renders the résumé inline so the recruiter can validate the
// form against the source. Two sources:
//   • `file`  — an in-memory File (Create, or a just-replaced résumé) → object URL.
//   • `src`   — a presigned GET URL (Edit: the résumé already stored on S3).
// PDFs render inline; other types (e.g. .docx, which browsers can't render
// natively) show a note. An Expand button opens a full-screen overlay.
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

  useEffect(() => {
    if (file === undefined) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const url = file !== undefined ? objectUrl : (src ?? null);
  const isPdf =
    mime === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf');
  const ext = fileName.split('.').pop()?.toLowerCase() ?? 'file';

  return (
    <section className="rc-sidecard rc-rpreview" aria-label="Résumé preview">
      <div className="rc-rpreview__hdrow">
        <h3 className="rc-sidecard__h">
          <Icons.IconFile />
          Résumé preview
        </h3>
        <div className="rc-rpreview__hdactions">
          {action ?? null}
          {url !== null && isPdf ? (
            <button
              type="button"
              className="rc-rpreview__expand"
              onClick={() => setExpanded(true)}
            >
              Expand
            </button>
          ) : null}
        </div>
      </div>
      {url !== null && isPdf ? (
        <iframe className="rc-rpreview__frame" title="Résumé preview" src={url} />
      ) : (
        <p className="rc-secnote">
          Inline preview isn’t available for a .{ext} file — the attached résumé
          is saved with the record and can be opened from Documents.
        </p>
      )}
      {expanded && url !== null ? (
        <div
          className="rc-rpreview__overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Résumé full preview"
        >
          <div className="rc-rpreview__ovbar">
            <span className="rc-rpreview__ovtitle">{fileName}</span>
            <button
              type="button"
              className="rc-rpreview__ovclose"
              onClick={() => setExpanded(false)}
            >
              Close
            </button>
          </div>
          <iframe className="rc-rpreview__ovframe" title="Résumé full preview" src={url} />
        </div>
      ) : null}
    </section>
  );
}
