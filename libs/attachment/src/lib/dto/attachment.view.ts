import type { AttachmentOwnerType } from './attachment-owner-type.js';

export interface AttachmentView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  storage_key: string;
  is_resume: boolean;
  uploaded_by_id: string | null;
  uploaded_at: string;
  created_at: string;
  updated_at: string;
}
