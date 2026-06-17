# Go-Live Known-Limitations Register

Deliberate gaps shipped to production with enforcement/behavior intentionally
deferred. Each entry states what is present, what is NOT yet enforced, and the
trust implication. Reviewed at each go-live gate.

> New entries: append under the relevant area with the date, the PR/branch, and
> an explicit "Risk" line. Do not remove an entry until the deferral is closed
> (link the closing PR).

---

## Companies

### off_limits: display-only, enforcement deferred
- **Date:** 2026-06-16 · **Branch:** `feat/companies-mockup-parity`
- **Present:** `company.off_limits` boolean field; account-hub off-limits banner;
  list facet + form toggle; included in company create/update + search facets.
- **NOT enforced:** the do-not-source flag is **display-only**. Nothing in
  sourcing / talent search / engagement reads `off_limits` to exclude an
  off-limits client's own people from a working set. Setting the flag changes
  what a recruiter *sees*, not what the system *permits*.
- **Risk:** a "do-not-source" banner the system does not enforce is a **trust
  gap** — an operator may rely on it as a guardrail it is not. Treat as
  informational only until enforcement lands.
- **Close criteria:** wire `off_limits` into the sourcing/search predicate so an
  off-limits company's employees are excluded from talent working sets (requires
  the talent→employer→company linkage), with a test proving exclusion.

---

## Requisitions

### Team scope + owner reassignment: deferred (unbacked)
- **Date:** 2026-06-16 · **Branch:** `feat/companies-mockup-parity`
- **Present:** the rebuilt Requisitions list differentiates breadth SERVER-SIDE
  by the authenticated principal — GET /v1/requisitions applies the A3/D4b
  visibility predicate from the caller's scopes, so a recruiter sees assigned +
  client-visible reqs and a `requisition:read:all` holder sees the full tenant
  set (no query param; the mockup's persona switcher is dropped). The backed
  filter chips (All / Only mine / Only hot / Show closed) and the owner cell
  (which DISPLAYS the real unassigned state) ship.
- **NOT present:** (1) a **"Team" scope** — there is no team-tier read exposed on
  the requisitions surface (the talent `?scope=my_team` analog), so a lead cannot
  pivot the list to "my team's reqs" beyond what their own visibility already
  resolves; (2) **owner reassignment** — recruiters lack an assign scope and
  there is no assignable-users endpoint here, so the owner cell offers no
  reassign action; (3) a **server-side owner-IS-NULL "Unassigned" filter** — the
  repository accepts no owner param, so "Unassigned" is shown per-row but is NOT
  a filter chip. Same shape as the Talent/Companies list deferrals.
- **Risk:** low — these are absent affordances, not unenforced guardrails. A lead
  reviewing breadth relies on principal-driven visibility, which IS enforced.
- **Close criteria:** expose a team-scope read (mirror talent `?scope=my_team`)
  + an `owner_id` filter (incl. IS NULL) on GET /v1/requisitions, and an
  assignable-users endpoint + assign scope for reassignment — then wire the
  "Team" / "Unassigned" chips and an owner reassign control.

### List pagination / facets: deferred (unbacked)
- **Date:** 2026-06-16 · **Branch:** `feat/companies-mockup-parity`
- **Present:** GET /v1/requisitions returns the visibility-scoped set ordered by
  `created_at desc`, **capped at 50** (no cursor). The list shows an honest
  "showing your 50 most recent (pagination coming)" note when the cap is hit.
- **NOT present:** keyset/cursor pagination + facet counts (the talent-records
  `?paged=true` superset has no requisitions analog yet). Client/status/sort
  controls operate over the (capped) loaded set, not the full server set.
- **Risk:** low — truncation is disclosed, not silent.
- **Close criteria:** add a `?paged=true` cursor + facet path to
  GET /v1/requisitions and wire server-side pagination/facets in the list.

---

## Talent

### RTBF / talent erasure: manual, with résumé-object + attachment orphaning
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** deleting a TalentRecord cascades the résumé **text** row
  (`talent_record.talent_resume_text`, `ON DELETE CASCADE` — ADR-0015). SSN-
  shaped patterns are redacted before that text is stored (D4).
- **NOT enforced:** (1) the **S3 résumé object is not deleted** by any
  application path — `Attachment.storage_key` points at the object, there is no
  `DeleteObject` in the app's IAM policy, and talent-delete does not touch S3;
  (2) **Attachment rows orphan** on talent-delete — `Attachment` references the
  talent by `owner_id` (cross-schema UUID, **no FK** per Architecture §7.3), so
  the cascade does not reach them; (3) the **ADR-0007 anonymization state
  machine is not built** — `is_anonymized` is a hardcoded `false` placeholder,
  and the Core Talent identity is not anonymized by ATS-side delete.
- **Risk:** **a verified right-to-be-forgotten request cannot be fully honored
  by the product alone.** Résumé text purges automatically, but the résumé
  *file* in S3 and its attachment metadata persist. Manual operator action is
  required to complete erasure — see the runbook below.
- **Mitigation (this PR):** the **manual erasure runbook**
  [doc/runbooks/talent-rtbf-erasure.md](runbooks/talent-rtbf-erasure.md)
  specifies how an operator, given a talent id, locates the attachment
  `storage_key`(s) and deletes the S3 object (incl. all versions — the bucket
  is versioned) before deleting the rows.
- **Close criteria:** wire attachment cleanup-by-owner on talent-delete (delete
  rows + tag/delete S3 objects), and build the ADR-0007 anonymization state
  machine. Until then, RTBF is a runbook-driven operator procedure.

### Consent capture: UI captured at create, grant deferred (Core-keying)
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** the Add-Talent flow captures the real 5-scope consent model
  (`profile_storage`, `resume_processing`, `matching`, `contacting`,
  `cross_tenant_visibility` — the `libs/consent` `CONSENT_SCOPES` enum) plus the
  R7 attestation, and **gates the save** on the two required scopes + the
  attestation. The grant endpoint (`POST /v1/consent/grant`) exists and is real.
- **NOT enforced:** the grant is **NOT fired at create**. `POST /v1/consent/grant`
  keys on a **Core `talent_id`** (`@IsUUID`); a freshly-created ATS
  `TalentRecord` has a nullable `core_talent_id` that is unset at create.
  Minting a thin Core Talent + overlay at ATS-create to populate it was
  evaluated and **rejected** — it would break the locked LINK-NOT-CREATE
  invariant (`ats-batch4b-talent-link.integration.spec.ts`: bit-identical
  `talent.*` row-counts under ATS ops) and Proof 6 (the single authorized
  `.talent.create(` call site lives in canonicalization only). Firing the grant
  keyed to the ATS record id instead would be a **wrong-key write** (consent-
  data corruption) and is explicitly not done.
- **Risk:** low for data integrity (no bad rows written); moderate for
  completeness — operator-captured consent intent is held with the record but
  not yet persisted as consent events until the Core identity is provisioned.
- **Close criteria:** provision the Core Talent identity through the authorized
  canonicalization/ingestion seam (NOT the ATS adapter), then fire the 5-scope
  grants keyed to the resulting `core_talent_id`. Closing this also closes the
  engagement-composer `findOverlayByTenant` overlay carry.

### Work history & education capture: deferred (seam)
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** a read-only "Work history & education — capture coming soon"
  reserved seam on the Add-Talent form.
- **NOT present:** structured work-history / education capture. The résumé
  parser extracts neither (`TalentRecordPrefill` omits them), there is no
  `talent-evidence` write controller, and `POST /v1/talent-records` stores
  neither. Rendering editable entries would be fabricated (nothing persists).
- **Risk:** low — absent affordance, disclosed as coming. Work history /
  education legitimately arrive as Core evidence satellites (TalentWorkHistory /
  TalentEducation).
- **Close criteria:** build the Core evidence satellites + write endpoints, then
  wire parse + capture.

### Duplicate detection: deferred (seam)
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** a "Duplicate check — Coming soon" reserved seam on the Add-Talent
  rail.
- **NOT present:** any duplicate-detection endpoint. The mockup's "no likely
  matches" result is not backed by anything, so it is not rendered (no
  fabricated result).
- **Risk:** low — disclosed as coming; the create flow never claims a dedup
  check ran.
- **Close criteria (fast-follow):** add a simple verified-email/profile-URL
  duplicate-surfacing read and wire it into the rail (surface-only; never
  silent-merge).
