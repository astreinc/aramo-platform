import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';

import { ObjectStorageService } from './object-storage.service.js';
import { S3ClientFactory } from './s3-client.factory.js';

// libs/object-storage module — A8-3a substrate.
//
// Mirrors the M5 PR-11 separation precedent (CrossSchemaConsistencyModule
// moved out of CommonModule per PL-88): cross-cutting infrastructure
// modules with their own AWS-SDK lifecycle + env surface + PII floor
// earn their own home. Future object-storage consumers (A8-3b résumé
// upload; later A4 owner_types — requisition / company / contact) all
// consume ObjectStorageService through this module.
//
// imports = [] — AramoError + AramoLogger are TS-level imports, not Nest
// providers; CommonModule is not required here.
// exports = [ObjectStorageService] only — S3ClientFactory is internal.

@Module({
  imports: [],
  providers: [
    S3ClientFactory,
    ObjectStorageService,
    {
      provide: 'ObjectStorageServiceLogger',
      useFactory: () => createAramoLogger(ObjectStorageService.name),
    },
  ],
  exports: [ObjectStorageService],
})
export class ObjectStorageModule {}
