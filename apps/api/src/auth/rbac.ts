import type { PoolClient } from 'pg';
import { type Permission, type Role, roleHasPermission } from '@genie/contracts';
import { errors } from '../lib/errors.js';
import { withClient } from '../db/index.js';

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
}

/**
 * Resolves the caller's membership in tenantId from the database. The tenantId
 * comes from the URL and is never trusted on its own: if the user has no
 * membership row the response is 404 (indistinguishable from a non-existent
 * tenant, so existence is not leaked), and if the role lacks the permission the
 * response is 403. The resulting TenantContext is the only thing handlers use
 * to scope queries.
 */
export async function requireTenantPermission(
  userId: string,
  tenantId: string,
  permission: Permission,
): Promise<TenantContext> {
  const role = await withClient((client) => lookupRole(client, userId, tenantId));
  if (!role) throw errors.notFound('Tenant');
  if (!roleHasPermission(role, permission)) throw errors.forbidden();
  return { tenantId, userId, role };
}

export async function lookupRole(client: PoolClient, userId: string, tenantId: string): Promise<Role | null> {
  const { rows } = await client.query<{ role: Role }>(
    'SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = $2',
    [userId, tenantId],
  );
  return rows[0]?.role ?? null;
}
