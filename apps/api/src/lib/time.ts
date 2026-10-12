/** All timestamps leave the API as UTC ISO-8601 strings. */
export function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
