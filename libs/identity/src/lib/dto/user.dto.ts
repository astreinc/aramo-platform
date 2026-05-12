// UserDto — public shape of the User entity. Returned by IdentityService.resolveUser.
// Mirrors libs/identity/prisma/schema.prisma User model; Date fields serialize
// to ISO strings at the public boundary.
export interface UserDto {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}
