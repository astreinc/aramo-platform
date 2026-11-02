import { Link, useParams } from 'react-router-dom';
import { FixedFormPreview } from '@aramo/document-templates-web';

import { OrgPageHeader } from '../ui/OrgPage';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7.3 — the read-only preview of an
// Aramo fixed form (/org/document-templates/forms/:templateId): the official PDF with its
// placed fields. No edit, no copy — a fixed form is used as it is.
export function AramoFormPage() {
  const { templateId = '' } = useParams();
  return (
    <div className="ox-tpl" data-testid="aramo-form-page">
      <OrgPageHeader section="templates" />
      <p>
        <Link className="ox-link" to="/org/document-templates">
          ← Our templates
        </Link>
      </p>
      <FixedFormPreview templateId={templateId} />
    </div>
  );
}
