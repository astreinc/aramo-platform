// CreateCompanyDepartmentRequestDto — POST /v1/companies/:company_id/departments
// payload. company_id is resolved from the path param, not the body.
export interface CreateCompanyDepartmentRequestDto {
  name: string;
  site_id?: string;
}
