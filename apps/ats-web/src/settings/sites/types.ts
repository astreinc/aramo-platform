// Settings Rebuild Directive 4 — sites/branches shapes.
//
// Hand-mirror of the libs/identity SiteView (leaf consumer of the HTTP surface
// — the no-@aramo/* import rule; the FE never imports backend types).

export interface SiteView {
  readonly id: string;
  readonly name: string;
  readonly is_active: boolean;
  readonly parent_site_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SiteListView {
  readonly items: SiteView[];
}

export interface CreateSiteRequest {
  name: string;
  parent_site_id?: string | null;
}

export interface UpdateSiteRequest {
  name?: string;
  parent_site_id?: string | null;
}
