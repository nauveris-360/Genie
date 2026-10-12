import { errors } from './errors.js';

export interface Cursor {
  createdAt: string;
  id: string;
}

/** Opaque, URL-safe cursor over (created_at DESC, id DESC). */
export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('bad shape');
    }
    if (Number.isNaN(Date.parse(parsed.createdAt))) throw new Error('bad date');
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw errors.validation('cursor is invalid.');
  }
}

export function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw errors.validation('limit must be an integer between 1 and 100.');
  }
  return n;
}

/** Given limit+1 rows fetched, returns the page and the cursor for the next one. */
export function pageOf<T extends { createdAt: string; id: string }>(rows: T[], limit: number): { data: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { data: rows, nextCursor: null };
  const data = rows.slice(0, limit);
  const last = data[data.length - 1]!;
  return { data, nextCursor: encodeCursor({ createdAt: last.createdAt, id: last.id }) };
}
