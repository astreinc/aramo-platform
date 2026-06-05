import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { TenantSettingRepository } from './tenant-setting.repository.js';
import { TenantSettingService } from './tenant-setting.service.js';

// SettingsModule — providers for the Settings S1 read seam.
//
// Leaf-lib shape (Gate-5 Ruling 2 — the UUID-logical-only variant): NO
// platform-domain imports. The module's only @aramo/* edge is `@aramo/common`
// (consumed transitively by PrismaService via createAramoLogger). There is
// no @aramo/identity import — tenant_id is a logical UUID, validated at the
// boundary by the JWT (apps/api's AuthContext).
//
// Imported by apps/api AppModule so the GET /v1/tenant/settings endpoint
// (apps/api/src/app/tenant-settings.controller.ts) can inject
// TenantSettingService. Not imported by any other lib (true leaf).
@Module({
  providers: [PrismaService, TenantSettingRepository, TenantSettingService],
  exports: [TenantSettingService, TenantSettingRepository],
})
export class SettingsModule {}
