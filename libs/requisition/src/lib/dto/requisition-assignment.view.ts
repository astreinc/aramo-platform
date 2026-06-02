export interface RequisitionAssignmentView {
  id: string;
  tenant_id: string;
  requisition_id: string;
  user_id: string;
  assigned_at: string;
  assigned_by_id: string | null;
}
