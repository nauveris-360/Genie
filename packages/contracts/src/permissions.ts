import type { Role } from './types.js';

/**
 * Server-enforced permission matrix. apps/api is the authority - it re-checks
 * every one of these on every request using the caller's membership row for
 * the tenantId in the URL, never a client-supplied role claim. The frontend
 * may import this to gate UI affordances, but a UI-only check is never a
 * substitute for the backend check and must not be relied upon as one.
 */
export type Permission =
  | 'tenant:create'
  | 'tenant:read'
  | 'website:read'
  | 'website:write'
  | 'agent:read'
  | 'agent:write'
  | 'provider:read'
  | 'provider:write'
  | 'modelPolicy:read'
  | 'modelPolicy:write'
  | 'task:read'
  | 'task:submit'
  | 'task:cancel'
  | 'approval:read'
  | 'approval:decide'
  | 'auditEvent:read';

const ALL_ROLES: Role[] = ['owner', 'admin', 'operator', 'viewer'];
const WRITE_ROLES: Role[] = ['owner', 'admin', 'operator'];
const ADMIN_ROLES: Role[] = ['owner', 'admin'];
const OWNER_ONLY: Role[] = ['owner'];

/**
 * Role -> roles permitted for each permission. `tenant:create` has no
 * membership context (anyone with a session may create a new tenant and
 * becomes its owner), so it is keyed by "any authenticated user", not role.
 */
export const PERMISSION_ROLES: Record<Permission, Role[]> = {
  'tenant:create': ALL_ROLES,
  'tenant:read': ALL_ROLES,
  'website:read': ALL_ROLES,
  'website:write': WRITE_ROLES,
  'agent:read': ALL_ROLES,
  'agent:write': WRITE_ROLES,
  'provider:read': ALL_ROLES,
  'provider:write': ADMIN_ROLES,
  'modelPolicy:read': ALL_ROLES,
  'modelPolicy:write': ADMIN_ROLES,
  'task:read': ALL_ROLES,
  'task:submit': WRITE_ROLES,
  'task:cancel': WRITE_ROLES,
  'approval:read': ALL_ROLES,
  'approval:decide': ADMIN_ROLES,
  'auditEvent:read': ALL_ROLES,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return PERMISSION_ROLES[permission].includes(role);
}

/** owner is a superset of admin for every documented permission; kept explicit above rather than derived, so the table is the literal source of truth. */
export const ROLE_HIERARCHY_NOTE =
  'owner > admin > operator > viewer. Each permission lists the roles allowed to perform it directly; there is no implicit inheritance in code, only in this table\'s contents.';

export { OWNER_ONLY };
