import { useId } from 'react';
import { FIELD_IMPORT_WARNING_COPY, TEXT_TAG_HELP, UPLOAD_OPTION_COPY, fieldImportSummary, fieldImportWarningText } from '@aramo/sign-fields';

import './field-placement.css';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-5 /
// P2-6 — the two opt-in upload options ("Import fields from a fillable PDF", "Apply text tags")
// and the result of an opted-in upload (`field_import`), ONE component for every web upload that
// offers them: the console form Studio ("Upload PDF…" / "Replace PDF…") and the sign-web
// envelope document step. The words are @aramo/sign-fields' (one place for web and mobile).
// Both options are off by default; a flag is sent only when ticked (uploadFlags).

export interface UploadFieldOptionsValue {
  readonly import_fields: boolean;
  readonly apply_text_tags: boolean;
}

export const NO_UPLOAD_FIELD_OPTIONS: UploadFieldOptionsValue = { import_fields: false, apply_text_tags: false };

/** The request flags: only the ticked ones (an unticked option sends nothing; the upload is unchanged). */
export function uploadFlags(v: UploadFieldOptionsValue): { import_fields?: true; apply_text_tags?: true } {
  return { ...(v.import_fields ? { import_fields: true as const } : {}), ...(v.apply_text_tags ? { apply_text_tags: true as const } : {}) };
}

export interface FieldImportResultValue {
  readonly fields: readonly unknown[];
  readonly warnings: ReadonlyArray<{ readonly code: string; readonly message: string; readonly name?: string; readonly page_number?: number }>;
  readonly stripped: readonly string[];
}

export function UploadFieldOptions({
  value,
  onChange,
  disabled = false,
  idPrefix = 'fpe',
}: {
  readonly value: UploadFieldOptionsValue;
  readonly onChange: (v: UploadFieldOptionsValue) => void;
  readonly disabled?: boolean;
  readonly idPrefix?: string;
}) {
  const id = useId();
  return (
    <fieldset className="fpe-upload-opts" data-testid={`${idPrefix}-upload-options`} disabled={disabled}>
      <legend className="fpe-label">When uploading</legend>
      {(['import_fields', 'apply_text_tags'] as const).map((k) => (
        <label key={k} className="fpe-check">
          <input type="checkbox" checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} aria-describedby={`${id}-${k}`} data-testid={`${idPrefix}-opt-${k}`} />
          <span>
            {UPLOAD_OPTION_COPY[k].label}
            <span id={`${id}-${k}`} className="fpe-faint fpe-upload-opts__help">
              {UPLOAD_OPTION_COPY[k].help}
            </span>
          </span>
        </label>
      ))}
      <details className="fpe-upload-opts__tags" data-testid={`${idPrefix}-text-tag-help`}>
        <summary>How to write text tags</summary>
        <p>
          <code>{TEXT_TAG_HELP.syntax}</code>
        </p>
        <p>
          Examples:{' '}
          {TEXT_TAG_HELP.examples.map((e, i) => (
            <span key={e}>
              {i > 0 ? ', ' : ''}
              <code>{e}</code>
            </span>
          ))}
        </p>
        <p>Types: {TEXT_TAG_HELP.types}.</p>
        {TEXT_TAG_HELP.notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </details>
    </fieldset>
  );
}

/** The result of an opted-in upload: N fields added, each warning in plain language, what was removed. */
export function FieldImportResult({ result, idPrefix = 'fpe', onClose }: { readonly result: FieldImportResultValue; readonly idPrefix?: string; readonly onClose?: () => void }) {
  return (
    <div className="fpe-import-result" role="status" data-testid={`${idPrefix}-import-result`}>
      <p className="fpe-import-result__summary" data-testid={`${idPrefix}-import-summary`}>
        <strong>{fieldImportSummary(result)}</strong>
      </p>
      {result.warnings.length > 0 ? (
        <ul className="fpe-import-result__warnings" data-testid={`${idPrefix}-import-warnings`}>
          {result.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`} data-code={w.code}>
              {w.code in FIELD_IMPORT_WARNING_COPY ? fieldImportWarningText(w.code) : w.message}
              {w.name !== undefined && w.name !== '' ? (
                <>
                  {' '}
                  (<span className="fpe-mono">{w.name}</span>
                  {w.page_number !== undefined ? `, page ${w.page_number + 1}` : ''})
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {result.stripped.length > 0 ? (
        <p className="fpe-faint" data-testid={`${idPrefix}-import-stripped`}>
          Removed from the PDF for safety: {result.stripped.join(', ')}.
        </p>
      ) : null}
      {onClose !== undefined ? (
        <button type="button" className="fpe-btn fpe-btn--sm" onClick={onClose} data-testid={`${idPrefix}-import-close`}>
          OK
        </button>
      ) : null}
    </div>
  );
}
