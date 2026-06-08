import { useRef, useState } from 'react';
import { Button, InlineAlert } from '@aramo/fe-foundation';

import {
  parseDraftFromResume,
  putResumeToStorage,
  requestResumeUploadUrl,
} from './talent-api';
import { uploadErrorMessage } from './error-messages';
import type { TalentRecordPrefill } from './types';

// R5 — the résumé upload section (the 3-step state machine).
//
// The flow (in-place on the CREATE form per ruling 1):
//   idle → (file selected) → uploading → parsing → parsed | partial | failed
//
// The parse_status branches (ruling 2):
//   - 'parsed':  prefill fields populate; banner: "review and complete"
//   - 'partial': prefill what parsed + a distinct banner ("we couldn't
//                find a name/email — please complete manually") — the
//                parse is an ASSIST, not a gate; don't discard extracted
//                fields
//   - 'failed':  empty prefill; "couldn't read this résumé — enter
//                manually; the file is still attached on save"
//
// In ALL three branches, the file metadata (storage_key + file_name +
// mime + size_bytes) is held in state and submitted to /v1/attachments
// by the parent (TalentCreateView) on successful create (ruling 3 —
// résumé attaches in all three branches; even a 'failed' parse preserves
// the file).
//
// The abandon case: if the recruiter closes/navigates without saving,
// the S3 lifecycle rule reaps the orphan-pending object after ~24h. The
// FE does NO cleanup; the UX shows "Uploaded — parsing/Parsed —
// complete the form" but NEVER "Saved" until the parent's create+attach
// completes.
//
// Hand-built local primitive (rule of three — R3 Tabs / S5b Table /
// S5c-1 Tree precedent; NO upload library — the presigned PUT is a raw
// fetch).

// The exported state shape — the parent reads this to know what to
// prefill + what to attach.
export interface ResumeUploadState {
  readonly status:
    | 'idle'
    | 'uploading'
    | 'parsing'
    | 'parsed'
    | 'partial'
    | 'failed'
    | 'error';
  readonly file?: File;
  readonly storage_key?: string;
  readonly prefill?: TalentRecordPrefill;
  readonly error?: string;
}

interface ResumeUploadSectionProps {
  readonly value: ResumeUploadState;
  readonly onChange: (next: ResumeUploadState) => void;
  // Fires when a parse completes with a usable prefill. The parent uses
  // this to populate the form fields. Parents may ignore failed/empty
  // prefills and surface the banner from `value.status` directly.
  readonly onPrefill: (prefill: TalentRecordPrefill) => void;
  readonly disabled?: boolean;
}

function bannerFor(
  status: ResumeUploadState['status'],
): { variant: 'success' | 'error'; text: string } | null {
  switch (status) {
    case 'parsed':
      return {
        variant: 'success',
        text: 'Résumé extracted — please review the prefilled fields and complete the form.',
      };
    case 'partial':
      return {
        variant: 'success',
        text: "We extracted some fields from the résumé but couldn't find a name or contact. Please complete the missing details manually.",
      };
    case 'failed':
      return {
        variant: 'error',
        text: "We couldn't read this résumé. Please enter the details manually — the file will still be attached when you save.",
      };
    default:
      return null;
  }
}

export function ResumeUploadSection({
  value,
  onChange,
  onPrefill,
  disabled = false,
}: ResumeUploadSectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickedNonce, setPickedNonce] = useState(0);

  const busy =
    value.status === 'uploading' || value.status === 'parsing';

  function reset(): void {
    onChange({ status: 'idle' });
    setPickedNonce((n) => n + 1);
  }

  async function handleFile(file: File): Promise<void> {
    // Step 1: ask the BE for a presigned PUT URL.
    onChange({ status: 'uploading', file });
    let storage_key: string;
    let presigned_url: string;
    const contentType = file.type === '' ? 'application/octet-stream' : file.type;
    try {
      const presign = await requestResumeUploadUrl({
        filename: file.name,
        content_type: contentType,
      });
      storage_key = presign.storage_key;
      presigned_url = presign.presigned_url;
    } catch (err) {
      onChange({
        status: 'error',
        file,
        error: uploadErrorMessage(err),
      });
      return;
    }

    // Step 2: direct-to-S3 PUT (raw fetch).
    try {
      await putResumeToStorage(presigned_url, file, contentType);
    } catch (err) {
      onChange({
        status: 'error',
        file,
        storage_key,
        error: uploadErrorMessage(err),
      });
      return;
    }

    // Step 3: parse.
    onChange({ status: 'parsing', file, storage_key });
    try {
      const result = await parseDraftFromResume({ storage_key });
      const status: ResumeUploadState['status'] =
        result.parse_status === 'parsed'
          ? 'parsed'
          : result.parse_status === 'partial'
            ? 'partial'
            : 'failed';
      onChange({
        status,
        file,
        storage_key,
        prefill: result.prefill,
      });
      // Hand the prefill back to the parent in ALL branches — 'failed'
      // has an empty prefill which is fine (parent's setState is a noop
      // for absent fields).
      onPrefill(result.prefill);
    } catch (err) {
      // Parse network failure (NOT parse_status='failed' — the BE never
      // throws on parse failure). The file IS uploaded; we still keep
      // storage_key so the attach-on-create can fire.
      onChange({
        status: 'error',
        file,
        storage_key,
        error: uploadErrorMessage(err),
      });
    }
  }

  const banner = bannerFor(value.status);

  return (
    <section
      className="talent-form__resume"
      aria-label="Résumé upload"
      data-testid="resume-upload-section"
    >
      <h3>Upload résumé (optional)</h3>
      <p className="talent-form__resume-help">
        Upload a PDF or Word résumé to prefill the form below. The parse
        is best-effort — you'll review and complete the fields. The file
        will be attached to the talent record on save.
      </p>
      <input
        ref={inputRef}
        key={pickedNonce}
        type="file"
        accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        disabled={disabled || busy}
        onChange={(ev) => {
          const file = ev.target.files?.[0];
          if (file !== undefined) {
            void handleFile(file);
          }
        }}
        data-testid="resume-file-input"
      />
      {value.status === 'uploading' && value.file !== undefined ? (
        <p role="status" data-testid="resume-status">
          Uploading {value.file.name}…
        </p>
      ) : null}
      {value.status === 'parsing' && value.file !== undefined ? (
        <p role="status" data-testid="resume-status">
          Parsing {value.file.name}…
        </p>
      ) : null}
      {value.status === 'error' && value.error !== undefined ? (
        <InlineAlert variant="error">{value.error}</InlineAlert>
      ) : null}
      {banner !== null ? (
        <InlineAlert variant={banner.variant}>{banner.text}</InlineAlert>
      ) : null}
      {(value.status === 'parsed' ||
        value.status === 'partial' ||
        value.status === 'failed' ||
        value.status === 'error') &&
      value.file !== undefined ? (
        <p data-testid="resume-attached">
          File: <strong>{value.file.name}</strong> · will be attached on
          save.{' '}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={reset}
            disabled={disabled}
          >
            Choose a different file
          </Button>
        </p>
      ) : null}
    </section>
  );
}
