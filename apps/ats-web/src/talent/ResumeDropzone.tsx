import { useRef, useState } from 'react';

import { Icons } from '../ui';

interface ResumeDropzoneProps {
  readonly onFile: (file: File) => void;
  readonly disabled?: boolean;
}

// Add-Talent intake (phase 1) — the resume dropzone. A resume is OPTIONAL
// (ATI-SEP-1 supersedes the former résumé-required ruling): the recruiter can
// always "Enter details manually" instead. Only PDF and DOCX are accepted — the
// extractor reads no other format (legacy .doc is not offered).
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
        {/* eslint-disable-next-line no-restricted-syntax -- G1/A3 escape hatch: native file picker — distinct native behavior, no fe-foundation primitive */}
        <input
          ref={inputRef}
          type="file"
          className="rc-visually-hidden"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
            Resume text is stored securely
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
