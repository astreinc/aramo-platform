import { useMemo } from 'react';
import { type Session } from '@aramo/fe-foundation';
import {
  TemplateStudio,
  organizationStudioDataSource,
  useDocTemplateRoutes,
  type OrganizationStudioApi,
} from '@aramo/document-templates-web';

import { OrgStudioHost, orgStudioErrorMessage, useOrgStudioAccount } from './OrgStudioHost';

// TEMPLATE-STUDIO-1 S-1 (directive §3; handoff §2) — /org/document-templates/:templateId:
// a tenant template in the shared Template Studio (libs/document-templates-web), full width
// in the Organization shell with Our templates active. Three states from the session's
// scopes (ORG-UX-1 §4.1): read-only · edit (document_template:author) · edit + Approve &
// activate (document_template:manage — tenant_owner / tenant_admin). Replaces the former
// detail screen and the draft editor (RtrTemplateDetail / RtrDraftEditor) on these routes.

export interface OrgTemplateStudioProps {
  readonly session: Session;
  readonly templateId: string;
  /** The Organization crumb's link (org admins); null for template authors. */
  readonly organizationHref: string | null;
  /** Organization administrators see the ADMIN badge in the account menu (as HomeShell). */
  readonly admin: boolean;
  /** Test seam — replaces tenant client calls. */
  readonly api?: Partial<OrganizationStudioApi>;
}

export function OrgTemplateStudio({ session, templateId, organizationHref, admin, api }: OrgTemplateStudioProps) {
  const routes = useDocTemplateRoutes();
  const dataSource = useMemo(
    () => organizationStudioDataSource({ session, organizationHref, listHref: routes.list, ...(api !== undefined ? { api } : {}) }),
    [session, organizationHref, routes.list, api],
  );
  const renderAccount = useOrgStudioAccount(admin);
  return (
    <OrgStudioHost testId="org-template-studio">
      <TemplateStudio
        key={templateId}
        context="organization"
        dataSource={dataSource}
        templateId={templateId}
        renderAccount={renderAccount}
        formatError={orgStudioErrorMessage}
      />
    </OrgStudioHost>
  );
}
