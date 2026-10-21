import { createContext, useContext, type ReactNode } from 'react';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2–8.4) — where the shared template screens navigate. The
// editor and detail screens moved out of ATS Settings into this lib; the host app decides
// the paths. The default is the Org Home mount (apps/home-web serves libs/org-admin-web
// at /org/*), the one place tenant template administration lives (ADR-0034 D11).
export interface DocTemplateRoutes {
  readonly list: string;
  readonly detail: (templateId: string) => string;
  readonly draft: (templateId: string) => string;
}

export const ORG_DOC_TEMPLATE_ROUTES: DocTemplateRoutes = {
  list: '/org/document-templates',
  detail: (templateId) => `/org/document-templates/${encodeURIComponent(templateId)}`,
  draft: (templateId) => `/org/document-templates/${encodeURIComponent(templateId)}/draft`,
};

const DocTemplateRoutesContext = createContext<DocTemplateRoutes>(ORG_DOC_TEMPLATE_ROUTES);

export function DocTemplateRoutesProvider({ routes, children }: { readonly routes: DocTemplateRoutes; readonly children: ReactNode }) {
  return <DocTemplateRoutesContext.Provider value={routes}>{children}</DocTemplateRoutesContext.Provider>;
}

export function useDocTemplateRoutes(): DocTemplateRoutes {
  return useContext(DocTemplateRoutesContext);
}
