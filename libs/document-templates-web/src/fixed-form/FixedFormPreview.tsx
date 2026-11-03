import { useEffect, useMemo, useState } from 'react';

import { templateProductsLine } from '../template-products';
import { type LoadedPdf } from '../pdf';

import { FixedFormCanvas } from './FixedFormCanvas';
import { base64ToBytes } from './fixed-form-model';
import { getFixedForm, getFixedFormPdf, type TenantFixedFormDetail } from './fixed-forms-api';
import './fixed-form.css';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.3 — the read-only preview of an
// Aramo fixed form for a tenant: the official PDF with its placed fields and who fills each one.
// No edit, no copy (a fixed form is never adopted).

export interface FixedFormPreviewProps {
  readonly templateId: string;
  readonly detailFn?: typeof getFixedForm;
  readonly pdfFn?: typeof getFixedFormPdf;
  /** Injected in tests (pdf.js does not run under jsdom). */
  readonly loadPdfFn?: (bytes: ArrayBuffer) => Promise<LoadedPdf>;
}

export function FixedFormPreview({ templateId, detailFn = getFixedForm, pdfFn = getFixedFormPdf, loadPdfFn }: FixedFormPreviewProps) {
  const [detail, setDetail] = useState<TenantFixedFormDetail | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([detailFn(templateId), pdfFn(templateId)]).then(
      ([d, p]) => {
        if (!live) return;
        setDetail(d);
        setBytes(base64ToBytes(p.content_base64));
      },
      () => {
        if (live) setError('This form is not available.');
      },
    );
    return () => {
      live = false;
    };
  }, [templateId, detailFn, pdfFn]);

  const labels = useMemo(() => new Map((detail?.variables ?? []).map((v) => [v.key, v.label])), [detail]);

  if (error !== null) {
    return (
      <p className="ffs-error" role="alert">
        {error}
      </p>
    );
  }
  if (detail === null) return <p className="ffs-note">Loading the form…</p>;
  return (
    <div className="ffs-preview" data-testid="fixed-form-preview">
      <p className="ffs-note">
        Aramo form · read-only · v{detail.version_number}
        {detail.products.length > 0 ? ` · Used in ${templateProductsLine(detail.products)}` : ''}
      </p>
      <p className="ffs-note">
        Signed by: {detail.signing.roles.filter((r) => r.kind === 'SIGNER').map((r) => r.label).join(', ') || '—'}
        {detail.variables.length > 0 ? ` · Prefilled: ${detail.variables.map((v) => v.label).join(', ')}` : ''}
      </p>
      <FixedFormCanvas
        pdfBytes={bytes}
        fields={detail.fields}
        roles={detail.signing.roles}
        variableLabel={(k) => `Prefilled: ${labels.get(k) ?? k}`}
        {...(loadPdfFn !== undefined ? { loadPdfFn } : {})}
      />
    </div>
  );
}
