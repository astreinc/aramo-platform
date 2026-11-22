import { useCallback, useEffect, useMemo, useState } from 'react';
import { PlacementPages, defaultFace, type PlacedField } from '@aramo/field-placement-web';

import { loadPdf as defaultLoadPdf, type LoadedPdf } from '../pdf';

import { FIXED_FORM_DOC_ID, FIXED_FORM_PALETTE, fixedFormFieldsToPlaced } from './fixed-form-placement';
import { fixedFormFieldLabel, type FixedFormField, type FixedFormRole } from './fixed-form-model';
import './fixed-form.css';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.3 — the official PDF rendered
// page by page (the shared pdf.js helpers, loaded lazily) with the placed fields drawn over it,
// read-only (the Org Home preview). FIELD-PARITY-1 P1-5 — drawn by the shared placement
// editor's page column (@aramo/field-placement-web PlacementPages); editing moved into the
// shared editor itself (the Studio uses PlacementEditor), so this view no longer edits.

export interface FixedFormCanvasProps {
  readonly pdfBytes: ArrayBuffer | null;
  readonly fields: readonly FixedFormField[];
  readonly roles: readonly FixedFormRole[];
  readonly variableLabel?: (key: string) => string;
  /** CSS width of a rendered page (px). */
  readonly pageWidth?: number;
  /** Injected in tests (pdf.js does not run under jsdom). */
  readonly loadPdfFn?: (bytes: ArrayBuffer) => Promise<LoadedPdf>;
}

export function FixedFormCanvas({ pdfBytes, fields, roles, variableLabel, pageWidth = 720, loadPdfFn = defaultLoadPdf }: FixedFormCanvasProps) {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    let loaded: LoadedPdf | null = null;
    setPdf(null);
    setFailed(false);
    if (pdfBytes === null) return undefined;
    loadPdfFn(pdfBytes).then(
      (p) => {
        loaded = p;
        if (live) setPdf(p);
        else p.destroy();
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      loaded?.destroy();
    };
  }, [pdfBytes, loadPdfFn]);

  const placed = useMemo(() => fixedFormFieldsToPlaced(fields), [fields]);
  const assignees = useMemo(() => roles.map((r) => ({ id: r.role_key, label: r.label })), [roles]);
  const renderPage = useCallback((_d: string, i: number, canvas: HTMLCanvasElement, w: number) => pdf?.render(i, canvas, w) ?? Promise.resolve(), [pdf]);

  if (pdfBytes === null) return <div className="ffs-empty">No PDF yet. Upload the official form to place fields on it.</div>;
  if (failed) return <div className="ffs-empty" role="alert">The PDF could not be displayed.</div>;
  if (pdf === null) return <div className="ffs-empty">Loading the form…</div>;

  const faceOf = (f: PlacedField) =>
    defaultFace(f, {
      typeLabel: (t) => FIXED_FORM_PALETTE.labels[t as keyof typeof FIXED_FORM_PALETTE.labels] ?? fixedFormFieldLabel(t),
      assignees,
      ...(variableLabel !== undefined ? { prefillLabel: variableLabel } : {}),
      unassigned: 'No role',
    });

  return (
    <div className="ffs-canvas">
      <PlacementPages
        documents={[{ id: FIXED_FORM_DOC_ID, title: '', pages: pdf.pages }]}
        renderPage={renderPage}
        fields={placed}
        faceOf={faceOf}
        pageWidth={pageWidth}
        idPrefix="ffs"
        readOnly
      />
    </div>
  );
}
