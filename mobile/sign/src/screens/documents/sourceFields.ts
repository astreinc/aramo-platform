// M-A13 #10 — the placed fields a sender sees over a document's source pages: read-only,
// in the editor's recipient colours (signing recipients in signing order) with the type
// label. Geometry stays PDF-native (page_number 0-based, points, bottom-left origin).
import { parseEnvelope } from '../../features/send/draftModel';
import { signingRecipients } from '../../features/send/recipientRoles';
import { fieldLabel } from '../../features/signing/signingMachine';
import { recipientColor } from '../../theme';

export interface SourceFieldMark {
  readonly key: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly color: string;
  readonly label: string;
  readonly recipientName: string;
}

/** The fields placed on `documentId`, from the sender envelope detail. */
export function sourceFieldMarks(detail: unknown, documentId: string): SourceFieldMark[] {
  const env = parseEnvelope(detail);
  const signers = signingRecipients(env.recipients);
  return env.fields
    .filter((f) => f.envelope_document_id === documentId)
    .map((f, i) => {
      const at = signers.findIndex((r) => r.id === f.signer_id);
      return {
        key: f.id || `field-${i}`,
        page: f.page_number,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        color: recipientColor(Math.max(0, at)),
        label: f.field_type === 'CHECKBOX' && f.label ? f.label : fieldLabel(f.field_type),
        recipientName: signers[at]?.name ?? '',
      };
    });
}
