// Embedded in the 409 TENANT_SELECTION_REQUIRED response's
// `error.details.tenants`. Per directive §8.2 + openapi/auth.yaml
// TenantSelectionRequiredDetails. Carries the list of tenants the user
// can choose between.

export interface TenantSelectionTenantDto {
  id: string;
  name: string;
}

export interface TenantSelectionRequiredDetailsDto {
  tenants: TenantSelectionTenantDto[];
}
