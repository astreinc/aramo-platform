import { useRef, useState } from 'react';

import { Icons } from '../ui';

interface ResumeDropzoneProps {
  readonly onFile: (file: File) => void;
  readonly onManual: () => void;
  readonly disabled?: boolean;
}

// Add-Talent intake (phase 1) — the résumé dropzone. Mockup parity, minus the
// fabricated "duplicate-checked" assurance (no dedup exists — see the dedup
// ReservedSeam). The assurances stated here are REAL: ADR-0015 secure résumé-
// text storage, server-side SSN-shaped redaction (D4), and the stated-facts-
// only / no-scoring parse posture (R10).
export function ResumeDropzone({
  onFile,
  onManual,
  disabled = false,
}: ResumeDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <div className="rc-dropwrap">
      <div
        className={`rc-dropzone${drag ? ' rc-dropzone--drag' : ''}`}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragEnter={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          setDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const file = e.dataTransfer.files?.[0];
          if (file !== undefined && !disabled) onFile(file);
        }}
      >
        <div className="rc-dropzone__ic" aria-hidden="true">
          <Icons.IconUpload />
        </div>
        <h2>Drop a résumé to start</h2>
        <p>
          We’ll parse it and pre-fill the profile in seconds. PDF or Word —
          you’ll review and complete every field before saving.
        </p>
        <div className="rc-dropzone__btns">
          <button
            type="button"
            className="rc-btn rc-btn--primary rc-btn--lg"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
          >
            <Icons.IconUpload />
            Browse files
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          className="rc-visually-hidden"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          disabled={disabled}
          data-testid="resume-file-input"
          onChange={(ev) => {
            const file = ev.target.files?.[0];
            if (file !== undefined) onFile(file);
          }}
        />
        <div className="rc-dropzone__meta">
          <span>
            <Icons.IconCheck />
            Résumé text stored securely (ADR-0015)
          </span>
          <span>
            <Icons.IconCheck />
            SSN-shaped data auto-redacted
          </span>
          <span>
            <Icons.IconCheck />
            Stated facts only — no scoring or ranking
          </span>
        </div>
      </div>
      <p className="rc-dropwrap__manual">
        No résumé handy?{' '}
        <button
          type="button"
          className="rc-link-action"
          disabled={disabled}
          onClick={onManual}
        >
          Enter details manually
        </button>
      </p>
    </div>
  );
}
