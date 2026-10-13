import type { Pool } from 'pg';
import { migrateUp, migrationStatus } from './migrate.js';

type Queryable = Pick<Pool, 'query'>;

/** Tenant-scoped tables whose isolation depends on FORCE ROW LEVEL SECURITY + the tenant_isolation policy. */
export const RLS_TABLES = ['websites', 'provider_connections', 'agents', 'model_policies', 'tasks', 'approvals', 'audit_events'] as const;

export interface RoleInfo {
  name: string;
  superuser: boolean;
  bypassRls: boolean;
}

export async function currentRole(db: Queryable): Promise<RoleInfo> {
  const { rows } = await db.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const r = rows[0];
  if (!r) throw new Error('Could not read the attributes of the current database role.');
  return { name: r.name, superuser: r.rolsuper, bypassRls: r.rolbypassrls };
}

/**
 * Superusers and BYPASSRLS roles ignore row-level security entirely, even on
 * tables with FORCE ROW LEVEL SECURITY, which would silently remove the
 * database layer of tenant isolation.
 */
export function unsafeRoleReasons(role: RoleInfo): string[] {
  const reasons: string[] = [];
  if (role.superuser) reasons.push('it is a superuser (superusers bypass row-level security)');
  if (role.bypassRls) reasons.push('it has BYPASSRLS (row-level security would not apply)');
  return reasons;
}

/** Every reason the tenant-isolation policies are not fully in force, or [] if they are. */
export async function rlsProblems(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; has_policy: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS has_policy
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
    [RLS_TABLES as unknown as string[]],
  );
  const byName = new Map(rows.map((r) => [r.relname, r]));
  const problems: string[] = [];
  for (const t of RLS_TABLES) {
    const r = byName.get(t);
    if (!r) { problems.push(`${t}: table missing`); continue; }
    if (!r.relrowsecurity) problems.push(`${t}: row-level security disabled`);
    if (!r.relforcerowsecurity) problems.push(`${t}: row-level security not forced`);
    if (!r.has_policy) problems.push(`${t}: tenant_isolation policy missing`);
  }
  return problems;
}

export interface PrepareOptions {
  production: boolean;
  migrateOnBoot: boolean;
  warn: (msg: string) => void;
}

export class UnsafeDatabaseError extends Error {
  constructor(problems: string[]) {
    super(`Refusing to start: ${problems.join(' | ')}`);
    this.name = 'UnsafeDatabaseError';
  }
}

/**
 * Startup gate, run before the server accepts requests. In production every
 * problem is fatal (fail closed); elsewhere problems are logged as warnings so
 * local setups keep working. Order matters: the role is checked BEFORE any
 * migration runs, so an unsafe role never creates or alters the schema.
 *  1. The connecting role is neither superuser nor BYPASSRLS.
 *  2. Schema: migrate now (MIGRATE_ON_BOOT=true) or, when a separate
 *     migration job owns the schema, require it to be exactly up to date
 *     (no pending, modified or unknown migrations).
 *  3. FORCE ROW LEVEL SECURITY + tenant_isolation are intact on every
 *     tenant-scoped table.
 */
export async function prepareDatabase(pool: Pool, opts: PrepareOptions): Promise<{ applied: string[] }> {
  const fail = (problems: string[]) => {
    if (!problems.length) return;
    if (opts.production) throw new UnsafeDatabaseError(problems);
    for (const p of problems) opts.warn(`database safety warning: ${p}`);
  };

  const role = await currentRole(pool);
  fail(unsafeRoleReasons(role).map((r) => `database role "${role.name}" is unsafe: ${r}`));

  let applied: string[] = [];
  if (opts.migrateOnBoot) {
    try {
      applied = (await migrateUp(pool)).applied;
    } catch (err) {
      if ((err as { code?: string }).code === '42501' || /permission denied|must be owner/.test((err as Error).message)) {
        throw new Error(
          `Refusing to start: MIGRATE_ON_BOOT=true but role "${role.name}" may not change the schema (${(err as Error).message}). ` +
            'Run migrations with the migration role (db/cli.js up) and set MIGRATE_ON_BOOT=false for the runtime role.',
        );
      }
      throw err;
    }
  } else {
    const s = await migrationStatus(pool);
    fail([
      ...(s.pending.length ? [`pending migrations (run the migration job first): ${s.pending.join(', ')}`] : []),
      ...(s.modified.length ? [`applied migrations modified since they ran: ${s.modified.join(', ')}`] : []),
      ...(s.unknown.length ? [`database has migrations this build does not know (code older than schema): ${s.unknown.join(', ')}`] : []),
    ]);
  }

  fail(await rlsProblems(pool));
  return { applied };
}
