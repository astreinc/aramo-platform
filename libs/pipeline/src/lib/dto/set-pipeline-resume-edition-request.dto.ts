// TALENT-INTEL-1 TI-1D-D — the body for the explicit "use this résumé for this
// requisition" mutation (PUT /v1/pipelines/{id}/resume-edition). Inserts a new
// append-only working-selection row; never mutates a prior selection.
export interface SetPipelineResumeEditionRequestDto {
  resume_edition_id: string;
  note?: string;
}
