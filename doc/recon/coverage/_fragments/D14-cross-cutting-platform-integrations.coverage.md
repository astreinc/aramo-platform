# D14 — Cross-Cutting Platform & External Integrations (COVERAGE)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

| surface | inspected | not_verified | method/command |
| --- | --- | --- | --- |
| `libs/events` source files | 5 | 0 | `find libs/events/src -name '*.ts' \| grep -Ev 'tests\|spec' \| wc -l` = 5; all read (envelope, port, lease-safe, module, index) |
| `libs/outbox-publisher` source files | 7 | 1 | `find libs/outbox-publisher/src -name '*.ts' \| grep -Ev 'tests\|spec' \| wc -l` = 8; `fake-outbox-publisher.ts` not opened |
| `apps/api/src/talent-intake-consumer` files | 7 | 1 | `find apps/api/src/talent-intake-consumer -name '*.ts' \| wc -l` = 8; `sqs-event.types.ts` not opened |
| `libs/mailer` source files | 3 | 5 | `find libs/mailer/src -name '*.ts' \| grep -Ev 'tests\|spec' \| wc -l` = 8; read module/port/ses-adapter; config, client-factory, stub-adapter, tokens, index not opened |
| `libs/object-storage` source files | 3 | 5 | `find libs/object-storage/src -name '*.ts' \| grep -Ev 'tests\|spec' \| wc -l` = 8; read module/service/s3-factory; key-convention, log-redaction, config, types, index not opened |
| `libs/microsoft-graph` source files | 2 | 8 | `find libs/microsoft-graph/src -name '*.ts' \| grep -Ev 'tests\|spec' \| wc -l` = 10; read delegated-authorization.service + index barrel; 8 domain/port files not opened |
| `libs/task` source files | 2 | 14 | `find libs/task/src -name '*.ts' \| grep -Ev 'tests\|spec' \| wc -l` = 16; read module + controller (routes); repository, prisma, DTOs, ports not opened |
| `libs/audit` source files | 2 | 0 | `find libs/audit/src -name '*.ts' \| grep -Ev 'tests\|spec' \| wc -l` = 2; both read (empty module + index) |
| BullMQ `@Processor` files (workspace) | 1 | 25 | `grep -rln "@Processor(" libs apps \| grep -Ev 'tests\|spec' \| wc -l` = 26; only `outbox-publisher.processor.ts` read in depth, remaining 25 enumerated by name only |
| `@aws-sdk/*` consumer files (workspace) | 7 | 7 | `grep -rln "@aws-sdk/" apps libs \| grep -Ev 'tests\|spec' \| wc -l` = 14; read eventbridge/lazy-eventbridge/ses-adapter/object-storage.service/s3-factory/sns-publisher + secrets-adapter class; cognito/kms/secret-cache/graph-adapter sites not opened |
| `talent-intake-events` Terraform module files | 1 | 2 | `find infrastructure/modules/talent-intake-events -name '*.tf' \| wc -l` = 3; read `main.tf`; `variables.tf`/`outputs.tf` not opened |
| prod ADR-0033 wiring (`talent-intake.tf`) | 1 | 0 | read `infrastructure/environments/prod/talent-intake.tf` in full |
| ADR anchors (0018, 0033) | 2 | 1 | `ls doc/adr/ \| grep -E '0018\|0033' \| grep '.md$' \| wc -l` = 3; read 0033 fully + 0018 head; the `Aramo-ADR-0018-...-LOCKED.md` mirror not opened |
| Task HTTP routes | 5 | 0 | `grep -cE "@(Get\|Post\|Patch\|Delete)\(" libs/task/src/lib/task.controller.ts` = 5; all mapped to the endpoint table |
| Other cross-cutting leaf libs (export, saved-list, entitlement, settings, canonical-reconcile, platform-trust, tenant-reset, canonicalization) | 0 (module/controller anchors only) | 8 | `@Controller` greps located export + saved-list controllers; internals belong to their own domains and were not inspected |
</content>
