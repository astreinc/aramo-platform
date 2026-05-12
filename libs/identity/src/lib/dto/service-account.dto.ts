// ServiceAccountDto — public shape of the ServiceAccount entity.
// ServiceAccount is parallel to User, not a User row (directive §3).
export interface ServiceAccountDto {
  id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
