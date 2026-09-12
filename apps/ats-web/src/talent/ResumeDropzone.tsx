import { useRef, useState } from 'react';

import { Icons } from '../ui';

interface ResumeDropzoneProps {
  readonly onFile: (file: File) => void;
  readonly disabled?: boolean;
}

// Add-Talent intake (phase 1) — the resume dropzone. A resume is REQUIRED to
// create a talent (no manual-entry fallback): every manual add starts here.
// The assurances stated here are REAL: ADR-0015 secure resume-text storage,
// server-side SSN-shaped redaction (D4), and the stated-facts-only /
// no-scoring parse posture (R10).
export function ResumeDropzone({
  onFile,
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
        <h2>Upload resume</h2>
        <p>Drag &amp; drop or click to browse · PDF, DOCX</p>
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
            Resume text stored securely (ADR-0015)
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
    </div>
  );
}
