import { Button } from '@aramo/fe-foundation';

import { InfoCircle, Segments, SignatureBlock, TALENT_NAME_KEY, type BindingMap, type SignatureInfo } from './dt-ui';

// DOC-TEMPLATE-ADMIN-RTR-1 — shared Preview + Approve dialogs (prototype §2.5/§2.6).
// Both are used by the RTR detail (preview a version) and the draft editor (preview the
// draft, confirm approve).
//
// Preview has two honest modes:
//  - 'sample'  — the SERVER's fixed-sample render (POST .../preview, §17): the title and
//                blocks exactly as the backend resolved them with its safe sample values.
//                The FE substitutes nothing; there is no browser-side sample table.
//  - 'content' — the stored wording of a version (the server sample preview is
//                DRAFT-only + manage-scoped), with fields shown as chips — no values invented.
// Neither creates an RTR or any business document; the amber band says so.

export interface PreviewBlock { readonly type: string; readonly text: string }

export interface PreviewContent {
  readonly label: string; // e.g. "Draft v4 · Standard Right to Represent"
  readonly mode: 'sample' | 'content';
  readonly title: string;
  // 'sample': server-resolved plain text. 'content': editable [Label] text.
  readonly blocks: readonly PreviewBlock[];
  // Present ONLY when the server reports that it appends the fixed signature block
  // (see signatureFrom). Absent → no signature is drawn.
  readonly signature?: SignatureInfo | null;
}

// The document page — shared by the Preview modal and the editor's inline Preview tab.
export function PreviewPaper({ content, map, className, testId }: {
  readonly content: PreviewContent;
  readonly map: BindingMap;
  readonly className: string;
  readonly testId: string;
}) {
  const sample = content.mode === 'sample';
  const blocks = content.blocks.filter((b) => b.text.trim() !== '');
  const sig = content.signature ?? null;
  return (
    <div className={className} data-testid={testId}>
      <div className="dt-pvpaper__title">{content.title}</div>
      {blocks.map((b, i) => {
        const body = sample ? b.text : <Segments text={b.text} map={map} />;
        return b.type === 'HEADING' ? (
          <div className="dt-pvpaper__h" key={i} data-testid="dt-preview-heading">{body}</div>
        ) : (
          <p key={i}>{body}</p>
        );
      })}
      {sig != null ? (
        <SignatureBlock
          mode={sample ? 'render' : 'template'}
          printedName={sig.printedName}
          nameLabel={map.labelByToken[TALENT_NAME_KEY] ?? 'Talent full name'}
          className="dt-sig--paper"
          testId="dt-preview-signature"
        />
      ) : null}
    </div>
  );
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
  const sample = content.mode === 'sample';
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
          {sample ? (
            <span><b>Sample preview data.</b> This doesn't create an RTR or any business document.</span>
          ) : (
            <span><b>Template wording.</b> Fields are filled in when an RTR is sent. This doesn't create an RTR or any business document.</span>
          )}
        </div>
        <div className="dt-pvbody">
          <div className="dt-pvpaperwrap">
            <PreviewPaper content={content} map={map} className="dt-pvpaper" testId="dt-preview-paper" />
          </div>
          <div className="dt-pvside">
            <div className="dt-pvside__t">{sample ? 'SAMPLE PREVIEW' : 'TEMPLATE WORDING'}</div>
            <div className="dt-pvside__note">
              {sample
                ? 'Fields are filled with fixed sample values by Aramo. Real RTRs use the talent and requisition on record when sent.'
                : 'Real RTRs use the talent and requisition on record when sent.'}
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

// Discard-draft confirm (§42, PO-authorized slice). Deletes the DRAFT only; the active
// version is untouched.
export function DiscardModal({
  draftVersion,
  busy,
  onCancel,
  onDiscard,
}: {
  readonly draftVersion: number;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <>
      <div className="dt-scrim" onClick={onCancel} />
      <div className="dt-modal dt-modal--approve" role="dialog" aria-label="Discard draft" data-testid="dt-discard-modal">
        <div className="dt-ap__title">Discard draft v{draftVersion}?</div>
        <div className="dt-ap__lead">Your changes are deleted. The active version is unchanged.</div>
        <div className="dt-ap__acts">
          <Button unstyled className="dt-btn dt-btn--neutral dt-btn--lg" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button unstyled className="dt-btn dt-btn--danger dt-btn--lg" onClick={onDiscard} disabled={busy} data-testid="dt-discard-confirm">
            Discard draft
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
