import type { ZodType } from 'zod';
import { errors } from './errors.js';

/** Parses with zod and converts the first issue into a contract-shaped validation_error. */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join('.') : 'body';
  throw errors.validation(`${path}: ${issue?.message ?? 'is invalid'}`);
}
