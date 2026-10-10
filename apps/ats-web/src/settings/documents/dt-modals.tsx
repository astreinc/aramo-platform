import { Button } from '@aramo/fe-foundation';

import { InfoCircle, SampleSegments, SAMPLE_BY_LABEL, type BindingMap } from './dt-ui';

// DOC-TEMPLATE-ADMIN-RTR-1 — shared Preview + Approve dialogs (prototype §2.5/§2.6).
// Both are used by the RTR detail (preview a version) and the draft editor (preview the
// draft, confirm approve). Preview is sample-data only — it never creates a business
// document; the amber band says so. The sample value list shows only the GOVERNED
// bindings that exist in the catalog (agreed-pay is excluded, per the locked ruling).

export interface PreviewContent {
  readonly label: string; // e.g. "Draft v4 · Standard Right to Represent"
  readonly title: string;
  readonly paras: readonly string[]; // editable [Label] text
}

export function PreviewModal({
  content,
  map,
  onClose,
}: {
  readonly content: PreviewContent;
  readonly map: BindingMap;
  readonly onClose: () => void;
}) {
  const sampleLabels = Object.keys(map.tokenByLabel).filter((l) => SAMPLE_BY_LABEL[l] !== undefined);
  return (
    <>
      <div className="dt-scrim" onClick={onClose} />
      <div className="dt-modal dt-modal--preview" role="dialog" aria-label="Preview document" data-testid="dt-preview-modal">
        <div className="dt-modal__head">
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="dt-modal__title">Preview document</span>
            <span className="dt-modal__sub">{content.label}</span>
          </span>
          <Button unstyled className="dt-modal__x" onClick={onClose} title="Close">×</Button>
        </div>
        <div className="dt-amber">
          <InfoCircle />
          <span><b>Sample preview data.</b> This doesn't create an RTR or any business document.</span>
        </div>
        <div className="dt-pvbody">
          <div className="dt-pvpaperwrap">
            <div className="dt-pvpaper">
              <div className="dt-pvpaper__title">{content.title}</div>
              {content.paras
                .filter((p) => p.trim() !== '')
                .map((p, i) => (
                  <p key={i}><SampleSegments text={p} map={map} /></p>
                ))}
              <div className="dt-pvsig">
                <span>Talent signature<span className="dt-pvsig__line" /></span>
                <span>Date<span className="dt-pvsig__line" /></span>
              </div>
            </div>
          </div>
          <div className="dt-pvside">
            <div className="dt-pvside__t">SAMPLE VALUES</div>
            {sampleLabels.map((l) => (
              <div className="dt-pvside__row" key={l}>
                <div className="dt-pvside__l">{l}</div>
                <div className="dt-pvside__v">{SAMPLE_BY_LABEL[l]}</div>
              </div>
            ))}
            <div className="dt-pvside__note">
              Highlighted text is filled from these values. Real RTRs use the talent, requisition and
              agreed pay on record when sent.
            </div>
          </div>
        </div>
        <div className="dt-modal__foot">
          <Button unstyled className="dt-btn dt-btn--neutral dt-btn--lg" onClick={onClose} data-testid="dt-preview-close">
            Close preview
          </Button>
        </div>
      </div>
    </>
  );
}

export function ApproveModal({
  draftVersion,
  activeVersion,
  busy,
  onCancel,
  onApprove,
}: {
  readonly draftVersion: number;
  readonly activeVersion: number | null;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onApprove: () => void;
}) {
  const bullets = [
    'This becomes the template used for all future RTRs.',
    activeVersion != null
      ? `The current active version (v${activeVersion}) will be retired.`
      : 'It becomes the first active version.',
    'RTRs that were already created will not change.',
  ];
  return (
    <>
      <div className="dt-scrim" onClick={onCancel} />
      <div className="dt-modal dt-modal--approve" role="dialog" aria-label="Approve version" data-testid="dt-approve-modal">
        <div className="dt-ap__title">Approve version v{draftVersion}?</div>
        <div className="dt-ap__lead">Once approved:</div>
        <div className="dt-ap__bullets">
          {bullets.map((b, i) => (
            <div className="dt-ap__b" key={i}><span className="dt-ap__dot" /><span>{b}</span></div>
          ))}
        </div>
        <div className="dt-ap__acts">
          <Button unstyled className="dt-btn dt-btn--neutral dt-btn--lg" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button unstyled className="dt-btn dt-btn--primary dt-btn--lg" onClick={onApprove} disabled={busy} data-testid="dt-approve-confirm">
            Approve &amp; activate
          </Button>
        </div>
      </div>
    </>
  );
}
