// Aramo Sign launch — resolves the contact of an envelope's sender (created_by)
// so E-Sign can email lifecycle notifications to them. libs/esign stays
// identity-agnostic: the composition root (apps/esign-service) binds this to the
// shared identity store. Returns null when the user is unknown or belongs to a
// different tenant (never a cross-tenant contact).

export const SENDER_DIRECTORY_PORT = 'SENDER_DIRECTORY_PORT';

export interface SenderContact {
  email: string;
  name: string;
}

export interface SenderDirectoryPort {
  findSender(tenant_id: string, user_id: string): Promise<SenderContact | null>;
}
