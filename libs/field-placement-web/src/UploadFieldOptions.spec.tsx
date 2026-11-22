import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FieldImportResult, NO_UPLOAD_FIELD_OPTIONS, UploadFieldOptions, uploadFlags, type UploadFieldOptionsValue } from './UploadFieldOptions';

// FIELD-PARITY-1 §5 P2-5 / P2-6 — the upload options (off by default, a flag only when ticked)
// and the import result (summary, each warning in plain language, what was removed).

function Harness({ onValue }: { readonly onValue: (v: UploadFieldOptionsValue) => void }) {
  const [v, setV] = useState(NO_UPLOAD_FIELD_OPTIONS);
  return (
    <UploadFieldOptions
      value={v}
      onChange={(n) => {
        setV(n);
        onValue(n);
      }}
      idPrefix="t"
    />
  );
}

describe('UploadFieldOptions', () => {
  it('both options start off; flags are sent only when ticked', () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    const imp = screen.getByTestId('t-opt-import_fields') as HTMLInputElement;
    const tags = screen.getByTestId('t-opt-apply_text_tags') as HTMLInputElement;
    expect(imp.checked).toBe(false);
    expect(tags.checked).toBe(false);
    expect(screen.getByText('Import fields from a fillable PDF')).toBeInTheDocument();
    expect(screen.getByText('Apply text tags ({{…}})')).toBeInTheDocument();
    expect(uploadFlags(NO_UPLOAD_FIELD_OPTIONS)).toEqual({});
    fireEvent.click(tags);
    expect(uploadFlags(onValue.mock.calls.at(-1)?.[0])).toEqual({ apply_text_tags: true });
    fireEvent.click(imp);
    expect(uploadFlags(onValue.mock.calls.at(-1)?.[0])).toEqual({ import_fields: true, apply_text_tags: true });
  });

  it('carries the short text-tag help', () => {
    render(<Harness onValue={() => undefined} />);
    expect(screen.getByTestId('t-text-tag-help')).toHaveTextContent('{{type:role[:required|optional][:label=Caption]}}');
    expect(screen.getByTestId('t-text-tag-help')).toHaveTextContent('{{signature:Seller}}');
  });
});

describe('FieldImportResult', () => {
  it('summarises, maps warning codes to plain language with the name and page, and lists what was removed', () => {
    render(
      <FieldImportResult
        idPrefix="t"
        result={{
          fields: [{}, {}],
          warnings: [
            { code: 'text_tag_role_unknown', message: 'server words', name: 'signature:Chair', page_number: 0 },
            { code: 'a_newer_code', message: 'Server message for a newer code.' },
          ],
          stripped: ['/AcroForm', '/JavaScript'],
        }}
      />,
    );
    expect(screen.getByTestId('t-import-summary')).toHaveTextContent('2 fields added · 2 warnings · active content removed');
    const items = screen.getByTestId('t-import-warnings').querySelectorAll('li');
    expect(items[0]).toHaveTextContent('A tag names a role that doesn’t exist here; assign its field yourself. (signature:Chair, page 1)');
    expect(items[1]).toHaveTextContent('Server message for a newer code.');
    expect(screen.getByTestId('t-import-stripped')).toHaveTextContent('Removed from the PDF for safety: /AcroForm, /JavaScript.');
  });

  it('no warnings and nothing removed: the summary alone', () => {
    render(<FieldImportResult idPrefix="t" result={{ fields: [], warnings: [], stripped: [] }} />);
    expect(screen.getByTestId('t-import-summary')).toHaveTextContent('No fields were added');
    expect(screen.queryByTestId('t-import-warnings')).toBeNull();
    expect(screen.queryByTestId('t-import-stripped')).toBeNull();
  });
});
