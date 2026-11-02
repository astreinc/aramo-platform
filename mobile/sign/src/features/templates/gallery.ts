// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.5 (R6-M) — the mobile app
// stays use-only (no editor). Besides the account's active templates (TemplatesList), it lists
// the Aramo templates for Aramo Sign the account has NOT adopted, each with **Use as it is**:
// one call (POST /v1/sign/sender/templates/library/{id}/adopt-and-use) adopts the template and
// approves the unchanged copy, which becomes the account's current version for its type.
//   - offered when the backend says so (sender context `template_use_as_is`: a Personal owner,
//     or a Business principal holding document_template:manage);
//   - anyone else sees "Ask an admin to approve this template" (the server refuses the call the
//     same way: details.reason template_approval_required);
//   - every other change: "Adopt and edit on desktop".
// Nothing is decided on the device: availability, plan and approval are the server's answers.
import { isApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import type { WorkspaceClient } from '../../api/workspaceClient';

export const ASK_ADMIN = 'Ask an admin to approve this template.';
export const EDIT_ON_DESKTOP = 'Adopt and edit on desktop.';
export const ALREADY_ADOPTED = 'This template is already in your templates.';
export const GALLERY_TITLE = 'Aramo templates';
export const GALLERY_INTRO = 'Ready-made templates from Aramo. Use one as it is, or adopt and edit it on desktop.';

export interface GalleryTemplate {
  readonly id: string;
  readonly name: string;
  readonly documentType: string | null;
  readonly description: string | null;
  readonly versionNumber: number | null;
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** The unadopted Aramo templates from the gallery answer (adopted ones are in the list above). */
export function unadoptedGallery(raw: unknown): GalleryTemplate[] {
  const items = Array.isArray(rec(raw)['items']) ? (rec(raw)['items'] as unknown[]) : [];
  return items
    .map(rec)
    .filter((i) => typeof i['template_id'] === 'string' && (i['adopted_template_id'] === null || i['adopted_template_id'] === undefined))
    .map((i) => ({
      id: i['template_id'] as string,
      name: text(i['name']) ?? 'Template',
      documentType: text(rec(i['document_type'])['name']),
      description: text(i['description']),
      versionNumber: typeof i['version_number'] === 'number' ? (i['version_number'] as number) : null,
    }));
}

/** The backend's "Use as it is" signal (never derived on the device). */
export function canUseAsIs(context: unknown): boolean {
  return rec(context)['template_use_as_is'] === true;
}

export async function loadTemplateGallery(workspace: WorkspaceClient): Promise<GalleryTemplate[]> {
  return unadoptedGallery(await workspace.call('/v1/sign/sender/templates/library', 'get', {}));
}

export async function adoptTemplateAsIs(workspace: WorkspaceClient, id: string): Promise<void> {
  await workspace.call('/v1/sign/sender/templates/library/{id}/adopt-and-use', 'post', { path: { id } });
}

/** Copy for a refused "Use as it is", keyed by the server's reason. */
export function asIsRefusalMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.reason === 'template_approval_required') return ASK_ADMIN;
    if (e.reason === 'already_adopted') return ALREADY_ADOPTED;
    return refusalMessage(e);
  }
  return 'Something went wrong. Try again.';
}
